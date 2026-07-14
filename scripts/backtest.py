"""Hyperliquid 跟单回测 v2 — 数据完整期精确模拟 + leader 官方历史曲线"""
import json, math, datetime, bisect
from collections import defaultdict

FEE_BPS, SLIP_BPS, F0 = 4.5, 3.0, 100_000
COPY_START = int(datetime.datetime(2026, 5, 16, 2).timestamp() * 1000)

fills = json.load(open("data/fills_raw.json"))
twaps = [t["fill"] for t in json.load(open("data/twap_fills.json"))]
seen = set(); merged = []
for f in fills + twaps:
    if f["tid"] in seen: continue
    seen.add(f["tid"]); merged.append(f)
perp = [f for f in merged if not f["coin"].startswith("@") and "/" not in f["coin"]]
perp.sort(key=lambda f: f["time"])

# 价格: 1h/1d K线 + 成交价
candles = json.load(open("data/candles.json")); candles1d = json.load(open("data/candles_1d.json"))
px_map = defaultdict(dict)
for c, rows in candles1d.items():
    for t, p in rows: px_map[c][t + 86400_000] = p
for c, rows in candles.items():
    for t, p in rows: px_map[c][t + 3600_000] = p
for f in perp: px_map[f["coin"]][f["time"]] = float(f["px"])
PX = {c: (sorted(d), [d[t] for t in sorted(d)]) for c, d in px_map.items()}
def price(c, t):
    ts, ps = PX[c]
    return ps[max(bisect.bisect_right(ts, t) - 1, 0)]

# leader 权益: 合并4个周期的 accountValueHistory
port = dict(json.load(open("data/portfolio.json")))
eqd = {}
for k in ["perpAllTime", "perpMonth", "perpWeek", "perpDay"]:
    for t, v in port[k]["accountValueHistory"]: eqd[int(t)] = float(v)
ET = sorted(eqd); EV = [eqd[t] for t in ET]
def leader_eq(t):
    i = bisect.bisect_right(ET, t) - 1
    if i < 0: return EV[0]
    if i >= len(ET) - 1: return EV[-1]
    w = (t - ET[i]) / (ET[i+1] - ET[i])
    return max(EV[i] * (1-w) + EV[i+1] * w, 100_000)

# leader 官方累计PnL: allTime 为骨架, 逐级 rebase 精细周期
def build_leader_pnl():
    base = sorted((int(t), float(v)) for t, v in port["perpAllTime"]["pnlHistory"])
    def interp(series, t):
        ts = [x for x, _ in series]
        i = bisect.bisect_right(ts, t) - 1
        if i < 0: return series[0][1]
        if i >= len(series) - 1: return series[-1][1]
        w = (t - ts[i]) / (ts[i+1] - ts[i])
        return series[i][1] * (1-w) + series[i+1][1] * w
    out = dict(base)
    for k in ["perpMonth", "perpWeek", "perpDay"]:
        rows = sorted((int(t), float(v)) for t, v in port[k]["pnlHistory"])
        if not rows: continue
        off = interp(sorted(out.items()), rows[0][0]) - rows[0][1]
        for t, v in rows: out[t] = v + off
    return sorted(out.items())
leader_pnl = build_leader_pnl()

# leader 全历史统计(fills口径)
lstat = dict(closed_pnl=defaultdict(float), fees=0.0, ntl=0.0, n=0)
for f in perp:
    lstat["closed_pnl"][f["coin"]] += float(f["closedPnl"])
    lstat["fees"] += float(f["fee"]) if f.get("feeToken") == "USDC" else 0
    lstat["ntl"] += float(f["px"]) * float(f["sz"]); lstat["n"] += 1

# 事件流
grp = defaultdict(list)
for f in perp:
    if f["time"] >= COPY_START: grp[(f["time"], f["coin"])].append(f)
events = []
for (t, c), fs in sorted(grp.items()):
    delta = sum(float(f["sz"]) * (1 if f["side"] == "B" else -1) for f in fs)
    tot = sum(float(f["sz"]) for f in fs)
    vwap = sum(float(f["px"]) * float(f["sz"]) for f in fs) / tot
    events.append((t, c, delta, vwap, [float(f["startPosition"]) for f in fs]))

funding = {c: sorted(rows) for c, rows in json.load(open("data/funding.json")).items()}
T_END = max(f["time"] for f in perp)

lpos = {}; fpos = defaultdict(float); cash = F0
fees_paid = funding_paid = trade_ntl = 0.0
n_trades = n_resync = 0; resync_ntl = 0.0
coin_flow = defaultdict(float); coin_fees = defaultdict(float)
trades_log = []
fr_idx = {c: 0 for c in funding}
def equity(t): return cash + sum(p * price(c, t) for c, p in fpos.items() if p)

curve = []; hour = COPY_START - COPY_START % 3600_000; ei = 0
lev_series = []
while hour <= T_END + 3600_000:
    while ei < len(events) and events[ei][0] < hour + 3600_000:
        t, c, delta, vwap, sps = events[ei]; ei += 1
        if c not in lpos: lpos[c] = min(sps, key=abs)
        if not any(abs(lpos[c] - sp) <= max(1e-3, abs(sp) * 1e-5) for sp in sps):
            best = min(sps, key=lambda sp: abs(sp - lpos[c]))
            n_resync += 1; resync_ntl += abs(best - lpos[c]) * vwap
            lpos[c] = best
        lpos[c] += delta
        if abs(lpos[c]) < 1e-9: lpos[c] = 0.0
        eq = equity(t)
        ratio = eq / leader_eq(t)
        target = lpos[c] * ratio
        tr = target - fpos[c]
        if abs(tr) * vwap < 1.0: continue
        px = vwap * (1 + SLIP_BPS / 1e4 * (1 if tr > 0 else -1))
        fee = abs(tr) * px * FEE_BPS / 1e4
        cash -= tr * px + fee
        coin_flow[c] -= tr * px + fee; coin_fees[c] += fee
        fees_paid += fee; trade_ntl += abs(tr) * px; n_trades += 1
        fpos[c] = target
        trades_log.append([t, c, round(tr, 4), round(px, 5)])
    for c, p in list(fpos.items()):
        if not p or c not in funding: continue
        rows = funding[c]; i = fr_idx[c]
        while i < len(rows) and rows[i][0] <= hour:
            if rows[i][0] > hour - 3600_000 and rows[i][0] >= COPY_START:
                pay = p * price(c, hour) * rows[i][1]
                cash -= pay; funding_paid += pay; coin_flow[c] -= pay
            i += 1
        fr_idx[c] = i
    e = equity(hour)
    gross = sum(abs(p) * price(c, hour) for c, p in fpos.items() if p)
    curve.append([hour, round(e, 2)])
    lev_series.append([hour, round(gross / e, 3) if e > 0 else 0])
    hour += 3600_000

for c, p in fpos.items(): coin_flow[c] += p * price(c, T_END)

eqs = [e for _, e in curve]
peak = -1e18; mdd = 0; mdd_t = None
for t_e, e in curve:
    if e > peak: peak = e
    dd = (peak - e) / peak if peak > 0 else 0
    if dd > mdd: mdd, mdd_t = dd, t_e
rets = [(eqs[i+1] - eqs[i]) / eqs[i] for i in range(len(eqs) - 1) if eqs[i] > 0]
mu = sum(rets) / len(rets); sd = math.sqrt(sum((r - mu)**2 for r in rets) / len(rets))
days = (curve[-1][0] - curve[0][0]) / 86400_000
final = eqs[-1]

results = {
  "address": "0xa65ce1d604fa901c13aa29f2126a57d9032e412b",
  "params": {"F0": F0, "fee_bps": FEE_BPS, "slip_bps": SLIP_BPS,
             "copy_start": COPY_START, "end": T_END, "model": "dynamic_proportional"},
  "copy": {
    "curve": curve, "leverage": lev_series[::4],
    "final": round(final, 2), "total_return": final / F0 - 1,
    "ann_return": (final / F0) ** (365 / days) - 1 if final > 0 else -1,
    "mdd": mdd, "mdd_t": mdd_t, "sharpe": mu / sd * math.sqrt(8760) if sd > 0 else 0,
    "days": days, "n_trades": n_trades, "trade_ntl": trade_ntl,
    "fees": fees_paid, "funding": funding_paid,
    "n_resync": n_resync, "resync_ntl": resync_ntl,
    "coin_pnl": {c: round(v, 2) for c, v in sorted(coin_flow.items(), key=lambda x: -x[1])},
    "final_pos": {c: round(p, 4) for c, p in fpos.items() if abs(p) > 1e-6},
  },
  "leader": {
    "pnl_curve": [[t, round(v, 0)] for t, v in leader_pnl],
    "eq_curve": [[t, round(eqd[t], 0)] for t in ET],
    "closed_pnl_by_coin": {c: round(v) for c, v in sorted(lstat["closed_pnl"].items(), key=lambda x: -x[1])},
    "total_fees": round(lstat["fees"]), "total_ntl": round(lstat["ntl"]), "n_fills": lstat["n"],
    "current_eq": EV[-1], "vlm": float(dict(port)["perpAllTime"].get("vlm", 0)),
  },
  "trades_sample": trades_log[:: max(1, len(trades_log) // 400)],
}
json.dump(results, open("data/results.json", "w"))

print(f"跟单期 {days:.0f} 天: ${F0:,} -> ${final:,.0f} ({(final/F0-1)*100:+.1f}%)  年化 {results['copy']['ann_return']*100:+.1f}%")
print(f"MDD {mdd*100:.1f}% @ {datetime.datetime.fromtimestamp(mdd_t/1000).date()}  Sharpe {results['copy']['sharpe']:.2f}")
print(f"交易 {n_trades} 笔 名义 ${trade_ntl/1e6:.2f}M  手续费 ${fees_paid:,.0f}  资金费 ${funding_paid:+,.0f}")
print(f"resync {n_resync} 次 (${resync_ntl/1e3:.0f}k)  期末持仓 {results['copy']['final_pos']}")
print("分币种 PnL:", {c: f"${v:,.0f}" for c, v in results["copy"]["coin_pnl"].items()})
print(f"\nleader: 当前权益 ${EV[-1]:,.0f}  累计PnL ${leader_pnl[-1][1]:,.0f}  全时段成交 ${lstat['ntl']/1e6:.0f}M ({lstat['n']}笔)")
print("leader 已实现PnL top:", {c: f"${v:,.0f}" for c, v in list(results['leader']['closed_pnl_by_coin'].items())[:10]})
