/* HL 跟单雷达 — 纯前端: 拉数据 → 全周期跟单回测 → 画像/标签/可跟单判定 */
"use strict";
const API = "https://api.hyperliquid.xyz/info";
const F0 = 100_000, FEE_BPS = 4.5, SLIP_BPS = 3.0, MIN_LEADER_EQ = 50_000;
const HOUR = 3600_000, DAY = 86400_000;
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtD = t => Number.isFinite(+t) ? new Date(+t).toISOString().slice(0, 10) : "—";
const fmtMo = t => Number.isFinite(+t) ? new Date(+t).toISOString().slice(0, 7) : "—";
const money = (v, sign) => (v < 0 ? "−" : (sign ? "+" : "")) + "$" + Math.abs(v).toLocaleString("en-US", {maximumFractionDigits: 0});
const pct = (v, d=1) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";

function log(msg, cls) {
  const el = $("plog");
  el.innerHTML += `<div class="${cls||""}">${msg}</div>`;
  el.scrollTop = el.scrollHeight;
}

let inflight = 0;
async function post(body, tries) {
  tries = tries || 4;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      if (r.status === 429) { log(`限流，等 ${4*(i+1)}s…`); await sleep(4000*(i+1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

/* ---------- 数据拉取 ---------- */
async function fetchPaged(mk, getTime, label) {
  const seen = new Set(), out = [];
  let start = 0; const now = Date.now();
  for (let page = 0; page < 60; page++) {
    const batch = await post(mk(start, now));
    if (!Array.isArray(batch) || !batch.length) break;
    let added = 0;
    for (const it of batch) {
      const k = it.fill ? it.fill.tid : it.tid;
      if (seen.has(k)) continue;
      seen.add(k); out.push(it); added++;
    }
    log(`${label}: +${added}（累计 ${out.length}）`);
    if (batch.length < 2000) break;
    const last = getTime(batch[batch.length - 1]);
    if (last <= start && !added) break;
    start = last;              // 重叠分页, tid 去重
    await sleep(150);
  }
  return out;
}

async function fetchAll(addr) {
  const D = {};
  log("拉取账户概况…");
  D.portfolio = Object.fromEntries(await post({type: "portfolio", user: addr}));
  D.vault = await post({type: "vaultDetails", vaultAddress: addr}).catch(() => null);
  await sleep(120);
  D.spot = await post({type: "spotClearinghouseState", user: addr}).catch(() => null);

  log("拉取成交记录…");
  D.fills = await fetchPaged(
    (s, n) => ({type: "userFillsByTime", user: addr, startTime: s, endTime: n, aggregateByTime: false}),
    b => b.time, "普通成交");
  D.twaps = (await fetchPaged(
    (s, n) => ({type: "userTwapSliceFillsByTime", user: addr, startTime: s, endTime: n}),
    b => b.fill.time, "TWAP 切片")).map(t => t.fill);

  // 合并去重
  const seen = new Set(); D.all = [];
  for (const f of D.fills.concat(D.twaps)) {
    if (seen.has(f.tid)) continue;
    seen.add(f.tid); D.all.push(f);
  }
  D.all.sort((a, b) => a.time - b.time);
  D.perp = D.all.filter(f => !f.coin.startsWith("@") && !f.coin.includes("/"));
  D.spotFills = D.all.length - D.perp.length;
  D.twapEarliest = D.twaps.length ? Math.min(...D.twaps.map(f => f.time)) : null;
  D.truncated = D.fills.length >= 9990;
  if (!D.perp.length) return D;
  log(`合计 ${D.all.length} 笔成交（perp ${D.perp.length} / 现货 ${D.spotFills}），` +
      `范围 ${fmtD(D.perp[0].time)} → ${fmtD(D.perp[D.perp.length-1].time)}`, "ok");

  // 当前实际持仓 (主 + HIP-3 各 dex)
  D.actual = {}; D.eqNow = 0;
  const dexes = new Set([""]);
  for (const f of D.perp) if (f.coin.includes(":")) dexes.add(f.coin.split(":")[0]);
  for (const dx of dexes) {
    const st = await post(dx ? {type: "clearinghouseState", user: addr, dex: dx} : {type: "clearinghouseState", user: addr});
    D.eqNow += parseFloat(st.marginSummary.accountValue);
    for (const p of st.assetPositions || []) D.actual[p.position.coin] = parseFloat(p.position.szi);
    await sleep(120);
  }

  // 各 coin 活跃窗口
  const now = Date.now();
  const win = {};
  for (const f of D.perp) {
    const c = f.coin;
    if (!win[c]) win[c] = [f.time - DAY, 0];
    win[c][1] = Math.abs(D.actual[c] || 0) > 1e-9 ? now : Math.min(now, f.time + 2 * DAY);
  }
  // K线: 1d 全窗口 + 1h 近期
  D.candles = {};
  log("拉取 K 线（" + Object.keys(win).length + " 个市场）…");
  for (const [c, [t0, t1]] of Object.entries(win)) {
    const px = {};
    const d1 = await post({type: "candleSnapshot", req: {coin: c, interval: "1d", startTime: t0, endTime: t1}}).catch(() => []);
    for (const r of d1 || []) px[r.t + DAY] = parseFloat(r.c);
    await sleep(120);
    const h0 = Math.max(t0, now - 199 * DAY);
    if (t1 > h0) {
      const h1 = await post({type: "candleSnapshot", req: {coin: c, interval: "1h", startTime: h0, endTime: t1}}).catch(() => []);
      for (const r of h1 || []) px[r.t + HOUR] = parseFloat(r.c);
      await sleep(120);
    }
    D.candles[c] = px;
  }
  // 资金费
  D.funding = {};
  log("拉取资金费率…");
  for (const [c, [t0, t1]] of Object.entries(win)) {
    const rows = []; let s = t0;
    for (let p = 0; p < 60; p++) {
      const b = await post({type: "fundingHistory", coin: c, startTime: s, endTime: t1}).catch(() => []);
      if (!Array.isArray(b) || !b.length) break;
      for (const r of b) rows.push([r.time, parseFloat(r.fundingRate)]);
      const last = b[b.length - 1].time;
      if (last <= s || b.length < 400) break;
      s = last + 1;
      await sleep(120);
    }
    rows.sort((a, b) => a[0] - b[0]);
    D.funding[c] = rows;
  }
  log("数据拉取完成", "ok");
  return D;
}

/* ---------- 价格 / 权益辅助 ---------- */
function buildPX(D) {
  const PX = {};
  for (const [c, m] of Object.entries(D.candles)) {
    const mm = {...m};
    for (const f of D.perp) if (f.coin === c) mm[f.time] = parseFloat(f.px);
    const ts = Object.keys(mm).map(Number).sort((a, b) => a - b);
    PX[c] = [ts, ts.map(t => mm[t])];
  }
  return c => PX[c] || [[], []];
}
function stepAt(ts, vs, t) {
  let lo = 0, hi = ts.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  return vs[Math.max(i, 0)];
}
function buildLeaderEq(D) {
  const m = {};
  for (const k of ["perpAllTime", "perpMonth", "perpWeek", "perpDay"])
    for (const [t, v] of (D.portfolio[k] || {accountValueHistory: []}).accountValueHistory) m[+t] = parseFloat(v);
  const ts = Object.keys(m).map(Number).sort((a, b) => a - b);
  const vs = ts.map(t => m[t]);
  return t => {
    let i = ts.findIndex(x => x > t);
    if (i === 0) return Math.max(vs[0], MIN_LEADER_EQ);
    if (i < 0) return Math.max(vs[vs.length - 1], MIN_LEADER_EQ);
    const w = (t - ts[i-1]) / (ts[i] - ts[i-1]);
    return Math.max(vs[i-1] * (1-w) + vs[i] * w, MIN_LEADER_EQ);
  };
}
function buildLeaderPnl(D) {
  const base = (D.portfolio.perpAllTime || {pnlHistory: []}).pnlHistory.map(([t, v]) => [+t, parseFloat(v)]);
  const out = new Map(base);
  const interp = (arr, t) => {
    if (!arr.length) return 0;
    let i = arr.findIndex(x => x[0] > t);
    if (i === 0) return arr[0][1];
    if (i < 0) return arr[arr.length-1][1];
    const w = (t - arr[i-1][0]) / (arr[i][0] - arr[i-1][0]);
    return arr[i-1][1] * (1-w) + arr[i][1] * w;
  };
  for (const k of ["perpMonth", "perpWeek", "perpDay"]) {
    const rows = ((D.portfolio[k] || {}).pnlHistory || []).map(([t, v]) => [+t, parseFloat(v)]).sort((a,b)=>a[0]-b[0]);
    if (!rows.length) continue;
    const cur = [...out.entries()].sort((a, b) => a[0] - b[0]);
    const off = interp(cur, rows[0][0]) - rows[0][1];
    for (const [t, v] of rows) out.set(t, v + off);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

/* ---------- 回测引擎 (全周期, 两段式) ---------- */
function buildEvents(D) {
  const gmap = new Map();
  for (const f of D.perp) {
    const k = f.time + "|" + f.coin;
    if (!gmap.has(k)) gmap.set(k, []);
    gmap.get(k).push(f);
  }
  return [...gmap.values()].map(fs => {
    const t = fs[0].time, c = fs[0].coin;
    let delta = 0, ntl = 0, tot = 0, closed = 0, fee = 0;
    for (const f of fs) {
      const sz = parseFloat(f.sz), p = parseFloat(f.px);
      delta += f.side === "B" ? sz : -sz;
      ntl += p * sz; tot += sz;
      closed += parseFloat(f.closedPnl); fee += parseFloat(f.fee || 0);
    }
    return {t, c, delta, vwap: ntl / tot, sps: fs.map(f => parseFloat(f.startPosition)),
            ntl, closed, fee, synthetic: false};
  }).sort((a, b) => a.t - b.t);
}

/* pass1: 重建 leader 仓位链, 记录缺口(resync), 生成回合(episodes), 合成幽灵平仓 */
function reconstructLeader(D, events) {
  const lpos = {}, lastEv = {}, episodes = [], open = {};
  const gaps = [];  // {t, ntl}
  for (const e of events) {
    const c = e.c;
    if (!(c in lpos)) lpos[c] = e.sps.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a, e.sps[0]);
    if (!e.sps.some(sp => Math.abs(lpos[c] - sp) <= Math.max(1e-3, Math.abs(sp) * 1e-5))) {
      const best = e.sps.reduce((a, b) => Math.abs(b - lpos[c]) < Math.abs(a - lpos[c]) ? b : a);
      gaps.push({t: e.t, ntl: Math.abs(best - lpos[c]) * e.vwap, kind: "resync"});
      lpos[c] = best;
    }
    const before = lpos[c];
    lpos[c] += e.delta;
    if (Math.abs(lpos[c]) < 1e-9) lpos[c] = 0;
    lastEv[c] = e;
    if (Math.abs(before) < 1e-9 && Math.abs(lpos[c]) > 1e-9)
      open[c] = {c, t0: e.t, px0: e.vwap, dir: Math.sign(e.delta), pnl: 0, fee: 0, maxNtl: 0};
    if (open[c]) {
      open[c].pnl += e.closed; open[c].fee += e.fee;
      open[c].maxNtl = Math.max(open[c].maxNtl, Math.abs(lpos[c]) * e.vwap);
      if (Math.abs(lpos[c]) < 1e-9) { open[c].t1 = e.t; episodes.push(open[c]); delete open[c]; }
    }
  }
  const phantoms = [];
  for (const [c, p] of Object.entries(lpos)) {
    const actual = D.actual[c] || 0;
    if (Math.abs(p - actual) > Math.max(1e-3, Math.abs(actual) * 1e-4)) {
      const e = lastEv[c];
      gaps.push({t: e.t + HOUR, ntl: Math.abs(actual - p) * e.vwap, kind: "phantom"});
      phantoms.push({t: e.t + HOUR, c, delta: actual - p, vwap: e.vwap,
                     sps: [p], ntl: 0, closed: 0, fee: 0, synthetic: true});
    }
  }
  events.push(...phantoms);
  events.sort((a, b) => a.t - b.t);
  return {episodes, gaps};
}

/* pass2: 逐笔等比跟单模拟 (从 startT 起, 初始资金 cap0) */
function simCopy(D, allEvents, startT, cap0, price, leaderEq) {
  const events = allEvents.filter(e => e.t >= startT);
  if (!events.length) return null;
  const fpos = {}, lp2 = {}, coinFlow = {}, curve = [];
  let cash = cap0, fees = 0, funding = 0, nTrades = 0, tradeNtl = 0;
  const T0 = events[0].t, T1 = Math.max(...D.perp.map(f => f.time));
  const frIdx = {};
  const equity = t => cash + Object.entries(fpos).reduce((s, [c, p]) => s + (p ? p * price(c, t) : 0), 0);
  let hour = T0 - T0 % HOUR, ei = 0, grossPeak = 0, levSum = 0, levN = 0, bankruptAt = null;
  while (hour <= T1 + HOUR) {
    while (ei < events.length && events[ei].t < hour + HOUR) {
      const e = events[ei++]; const c = e.c;
      if (!(c in lp2)) lp2[c] = e.sps.reduce((a, b) => Math.abs(b) < Math.abs(a) ? b : a, e.sps[0]);
      if (!e.synthetic && !e.sps.some(sp => Math.abs(lp2[c] - sp) <= Math.max(1e-3, Math.abs(sp) * 1e-5)))
        lp2[c] = e.sps.reduce((a, b) => Math.abs(b - lp2[c]) < Math.abs(a - lp2[c]) ? b : a);
      lp2[c] += e.delta;
      if (Math.abs(lp2[c]) < 1e-9) lp2[c] = 0;
      const eq = equity(e.t);
      if (eq <= 0) { bankruptAt = e.t; break; }
      const target = lp2[c] * eq / leaderEq(e.t);
      const tr = target - (fpos[c] || 0);
      if (Math.abs(tr) * e.vwap < 1) continue;
      const p = e.vwap * (1 + SLIP_BPS / 1e4 * Math.sign(tr));
      const fee = Math.abs(tr) * p * FEE_BPS / 1e4;
      cash -= tr * p + fee;
      coinFlow[c] = (coinFlow[c] || 0) - tr * p - fee;
      fees += fee; tradeNtl += Math.abs(tr) * p; nTrades++;
      fpos[c] = target;
    }
    if (bankruptAt) break;
    for (const [c, p] of Object.entries(fpos)) {
      if (!p || !D.funding[c]) continue;
      const rows = D.funding[c];
      let i = frIdx[c] || 0;
      while (i < rows.length && rows[i][0] <= hour) {
        if (rows[i][0] > hour - HOUR && rows[i][0] >= T0) {
          const pay = p * price(c, hour) * rows[i][1];
          cash -= pay; funding += pay; coinFlow[c] = (coinFlow[c] || 0) - pay;
        }
        i++;
      }
      frIdx[c] = i;
    }
    const eq = equity(hour);
    const gross = Object.entries(fpos).reduce((s, [c, p]) => s + Math.abs(p) * price(c, hour), 0);
    if (eq > 0 && gross > 0) { levSum += gross / eq; levN++; grossPeak = Math.max(grossPeak, gross / eq); }
    curve.push([hour, Math.round(eq * 100) / 100]);
    hour += HOUR;
  }
  for (const [c, p] of Object.entries(fpos)) if (p) coinFlow[c] += p * price(c, T1);
  return {curve, cash, fees, funding, nTrades, tradeNtl, coinFlow, bankruptAt,
          avgLev: levN ? levSum / levN : 0, maxLev: grossPeak};
}

/* 编排: TWAP 保留期前用官方收益等比换算, 之后逐笔精确; 缺口小则全程逐笔 */
function runBacktest(D) {
  const px = buildPX(D);
  const price = (c, t) => { const [ts, vs] = px(c); return ts.length ? stepAt(ts, vs, t) : 0; };
  const leaderEq = buildLeaderEq(D);
  const events = buildEvents(D);
  const {episodes, gaps} = reconstructLeader(D, events);
  const T0 = events[0].t;
  const cliff = D.twapEarliest && D.twapEarliest > T0 + 7 * DAY ? D.twapEarliest : null;

  let preGapShare = 0;
  if (cliff) {
    const preGapNtl = gaps.filter(g => g.t < cliff).reduce((s, g) => s + g.ntl, 0);
    const preNtl = events.filter(e => e.t < cliff).reduce((s, e) => s + e.ntl, 0);
    preGapShare = preNtl > 0 ? preGapNtl / preNtl : 0;
  }
  const hybrid = cliff && preGapShare > 0.05;

  let prefix = [], cap0 = F0, simStart = T0;
  if (hybrid) {
    // 前段: 官方 pnl / 权益 链式收益, 等比映射到跟单资金
    const pnl = buildLeaderPnl(D).filter(([t]) => t >= T0 - 7 * DAY && t <= cliff);
    // 权益采样可能缺失(显示为0), 用"历史峰值的25%"兜底做保守分母
    const eqSamples = [];
    for (const k of ["perpAllTime", "perpMonth", "perpWeek", "perpDay"])
      for (const [t, v] of ((D.portfolio[k] || {}).accountValueHistory || [])) eqSamples.push([+t, parseFloat(v)]);
    eqSamples.sort((a, b) => a[0] - b[0]);
    let eq = F0, peakEq = 0, si = 0;
    prefix = [[T0, F0]];
    for (let i = 1; i < pnl.length; i++) {
      const t = pnl[i-1][0];
      while (si < eqSamples.length && eqSamples[si][0] <= t) peakEq = Math.max(peakEq, eqSamples[si++][1]);
      const denom = Math.max(leaderEq(t), peakEq * 0.25, MIN_LEADER_EQ);
      let r = (pnl[i][1] - pnl[i-1][1]) / denom;
      r = Math.max(-0.35, Math.min(0.35, r));
      eq = Math.max(eq * (1 + r), 1000);
      if (pnl[i][0] > T0) prefix.push([pnl[i][0], Math.round(eq * 100) / 100]);
    }
    prefix.push([cliff, eq]);
    cap0 = eq; simStart = cliff;
  }
  const sim = simCopy(D, events, simStart, cap0, price, leaderEq);
  const curve = prefix.filter(p => p[0] < (sim ? sim.curve[0][0] : Infinity)).concat(sim ? sim.curve : []);

  // 统计 (整段曲线)
  const eqs = curve.map(x => x[1]);
  let peak = -1e18, mdd = 0, mddT = curve[0][0];
  for (const [t, e] of curve) { peak = Math.max(peak, e); const dd = peak > 0 ? (peak - e) / peak : 0; if (dd > mdd) { mdd = dd; mddT = t; } }
  const simCurve = sim ? sim.curve : [];
  const rets = [];
  for (let i = 1; i < simCurve.length; i++) if (simCurve[i-1][1] > 0) rets.push(simCurve[i][1] / simCurve[i-1][1] - 1);
  const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = rets.length ? Math.sqrt(rets.reduce((a, r) => a + (r - mu) ** 2, 0) / rets.length) : 0;
  const days = (curve[curve.length-1][0] - curve[0][0]) / DAY;
  const bankruptAt = sim && sim.bankruptAt;
  const final = bankruptAt ? 0 : eqs[eqs.length - 1];
  const nResync = gaps.filter(g => g.kind === "resync").length;
  const nPhantom = gaps.filter(g => g.kind === "phantom").length;
  return {curve, final, days, mdd, mddT, bankruptAt,
    totalReturn: final / F0 - 1,
    annReturn: final > 0 && days > 20 ? (final / F0) ** (365 / days) - 1 : (final > 0 ? final / F0 - 1 : -1),
    sharpe: sd > 0 ? mu / sd * Math.sqrt(8760) : 0,
    fees: sim ? sim.fees : 0, funding: sim ? sim.funding : 0,
    nTrades: sim ? sim.nTrades : 0, tradeNtl: sim ? sim.tradeNtl : 0,
    coinFlow: sim ? sim.coinFlow : {},
    avgLev: sim ? sim.avgLev : 0, maxLev: sim ? sim.maxLev : 0,
    nResync, resyncNtl: gaps.filter(g => g.kind === "resync").reduce((s, g) => s + g.ntl, 0),
    nPhantom, phantomNtl: gaps.filter(g => g.kind === "phantom").reduce((s, g) => s + g.ntl, 0),
    episodes, price,
    hybrid, cliff: hybrid ? cliff : null, preGapShare,
    preReturn: hybrid ? cap0 / F0 - 1 : null,
    simReturn: sim && !bankruptAt ? final / cap0 - 1 : (bankruptAt ? -1 : null),
    simStart, simCap0: cap0};
}

/* ---------- 画像 / 标签 / 判定 ---------- */
function analyze(D, bt) {
  const A = {};
  const perp = D.perp;
  const t0 = perp[0].time, t1 = perp[perp.length - 1].time;
  A.ageDays = (Date.now() - t0) / DAY;
  A.lastActiveDays = (Date.now() - t1) / DAY;
  A.eqNow = D.eqNow;
  const pnlCurve = buildLeaderPnl(D);
  A.officialPnl = pnlCurve.length ? pnlCurve[pnlCurve.length - 1][1] : 0;
  A.pnlCurve = pnlCurve;
  A.vlm = parseFloat((D.portfolio.perpAllTime || {}).vlm || 0);

  // 成交结构
  let ntl = 0, makerNtl = 0, twapNtl = 0, feeSum = 0;
  const coinNtl = {}, hourHist = Array(24).fill(0);
  let weekendNtl = 0;
  const twapTids = new Set(D.twaps.map(f => f.tid));
  for (const f of perp) {
    const n = parseFloat(f.px) * parseFloat(f.sz);
    ntl += n; feeSum += parseFloat(f.fee || 0);
    if (!f.crossed) makerNtl += n;
    if (twapTids.has(f.tid)) twapNtl += n;
    coinNtl[f.coin] = (coinNtl[f.coin] || 0) + n;
    const d = new Date(f.time);
    hourHist[d.getUTCHours()] += n;
    if ([0, 6].includes(d.getUTCDay())) weekendNtl += n;
  }
  A.ntl = ntl; A.makerShare = makerNtl / ntl; A.twapShare = twapNtl / ntl;
  A.weekendShare = weekendNtl / ntl; A.feeSum = feeSum;
  A.hhi = Object.values(coinNtl).reduce((s, v) => s + (v / ntl) ** 2, 0);
  A.nCoins = Object.keys(coinNtl).length;
  A.topCoins = Object.entries(coinNtl).sort((a, b) => b[1] - a[1]).slice(0, 5);
  A.hourHist = hourHist;
  // 活跃时段: 找占比最高的连续8小时窗 (UTC)
  let best = 0, bestH = 0;
  for (let h = 0; h < 24; h++) {
    let s = 0;
    for (let k = 0; k < 8; k++) s += hourHist[(h + k) % 24];
    if (s > best) { best = s; bestH = h; }
  }
  A.activeWindowUTC = [bestH, (bestH + 8) % 24];
  A.activeWindowShare = best / ntl;
  const activeDays = new Set(perp.map(f => Math.floor(f.time / DAY))).size;
  A.activeDays = activeDays;
  A.fillsPerActiveDay = perp.length / activeDays;

  // 回合统计
  const eps = bt.episodes.filter(e => e.maxNtl > 1000);
  A.nEpisodes = eps.length;
  if (eps.length) {
    const wins = eps.filter(e => e.pnl - e.fee > 0);
    A.winRate = wins.length / eps.length;
    const gw = eps.reduce((s, e) => s + Math.max(e.pnl - e.fee, 0), 0);
    const gl = eps.reduce((s, e) => s + Math.max(-(e.pnl - e.fee), 0), 0);
    A.profitFactor = gl > 0 ? gw / gl : 99;
    const durs = eps.map(e => (e.t1 - e.t0) / HOUR).sort((a, b) => a - b);
    A.medianHoldH = durs[Math.floor(durs.length / 2)];
    A.longShare = eps.filter(e => e.dir > 0).length / eps.length;
  }
  // 事件研究: 入场后24h方向收益 (择时/信息优势代理)
  let hit = 0, n = 0; const fwd = [];
  for (const e of eps) {
    if (e.t0 + 24 * HOUR > t1 + 2 * DAY) continue;
    const p24 = bt.price(e.c, e.t0 + 24 * HOUR);
    if (!p24 || !e.px0) continue;
    const r = e.dir * (p24 / e.px0 - 1);
    fwd.push(r); if (r > 0) hit++; n++;
  }
  A.entryHit24 = n >= 8 ? hit / n : null;
  A.entryFwdMed = n >= 8 ? fwd.sort((a, b) => a - b)[Math.floor(n / 2)] : null;
  A.entryN = n;

  // 现货对冲/套利线索
  A.spotShare = D.spotFills / (D.all.length || 1);
  const spotBal = (D.spot && D.spot.balances || []).filter(b => parseFloat(b.total) > 0).length;
  A.hedgeHint = spotBal > 1 && A.spotShare > 0.15;
  A.fundingShare = Math.abs(bt.funding) > 0 && Math.abs(bt.totalReturn * F0) > 0
    ? -bt.funding / Math.abs(bt.totalReturn * F0 || 1) : 0;

  /* 标签 */
  const tags = [];
  const peakEq = Math.max(...["perpAllTime","perpMonth"].flatMap(k =>
    ((D.portfolio[k]||{}).accountValueHistory||[]).map(([,v]) => parseFloat(v))), 0);
  A.peakEq = peakEq;
  if (peakEq > 1e6 || A.vlm > 5e7) tags.push(["巨鲸", "mint", `峰值权益 ${money(peakEq)} · 累计成交 ${money(A.vlm)}`]);
  if (D.vault) tags.push(["金库(Vault)", "blue", "该地址是 HL 金库，接受他人存款"]);
  if (A.twapShare > 0.2) tags.push(["机构式执行", "blue", `${(A.twapShare*100).toFixed(0)}% 成交量走 TWAP 算法单`]);
  const isQuant = A.fillsPerActiveDay > 80 && A.nCoins > 12 && A.medianHoldH < 24;
  const isSubjective = A.hhi > 0.25 && A.medianHoldH > 24;
  if (isQuant) tags.push(["量化/高频特征", "blue", `日均 ${A.fillsPerActiveDay.toFixed(0)} 笔 · ${A.nCoins} 个市场 · 中位持仓 ${A.medianHoldH.toFixed(0)}h`]);
  else if (isSubjective) tags.push(["主观重仓", "amber", `持仓集中度 HHI ${A.hhi.toFixed(2)} · 中位持仓 ${(A.medianHoldH/24).toFixed(1)} 天`]);
  if (A.hedgeHint) tags.push(["现货对冲线索", "blue", "现货+永续同时活跃，可能有套利/对冲腿"]);
  if (A.entryHit24 !== null && A.entryHit24 >= 0.65 && A.entryN >= 15)
    tags.push(["疑似信息/择时优势", "red", `入场后24h方向胜率 ${(A.entryHit24*100).toFixed(0)}%（${A.entryN} 次回合，仅统计信号）`]);
  if (A.lastActiveDays > 14) tags.push(["已不活跃", "red", `${A.lastActiveDays.toFixed(0)} 天无成交`]);
  A.tags = tags;

  /* 水平评分 */
  let score = 50;
  score += Math.max(-15, Math.min(20, (A.officialPnl / Math.max(peakEq, 1e5)) * 20));
  score += Math.max(-10, Math.min(15, bt.sharpe * 8));
  score -= Math.min(20, Math.max(0, (bt.mdd - 0.3) * 60));
  if (A.winRate) score += (A.winRate - 0.5) * 30;
  if (A.ageDays > 365) score += 5;
  if (A.profitFactor > 1.5) score += 5;
  score = Math.max(5, Math.min(95, score));
  A.score = score;
  A.grade = score >= 75 ? "A（顶部梯队）" : score >= 60 ? "B（稳健盈利）" : score >= 45 ? "C（普通/波动大）" : "D（负期望或高险）";

  /* 可跟单判定 */
  const reasons = [];
  let verdict = "可以小仓位跟单", vcls = "warn";
  if (bt.bankruptAt) { verdict = "不建议跟单"; vcls = "neg"; reasons.push(`等比全额跟单在 ${fmtD(bt.bankruptAt)} 爆仓（杠杆过高）`); }
  else if (bt.totalReturn < -0.25 || (bt.totalReturn < 0 && bt.sharpe < 0)) { verdict = "不建议跟单"; vcls = "neg"; reasons.push(`全周期跟单模拟为大幅负收益（${(bt.totalReturn * 100).toFixed(0)}%）`); }
  else if (bt.totalReturn < 0 && bt.mdd > 0.5) { verdict = "不建议跟单"; vcls = "neg"; reasons.push(`全周期收益为负且最大回撤 ${(bt.mdd*100).toFixed(0)}%`); }
  else if (bt.mdd > 0.5) { verdict = "谨慎：需减半杠杆"; vcls = "warn"; reasons.push(`模拟最大回撤 ${(bt.mdd*100).toFixed(0)}%，全额等比跟单会被洗出局`); }
  else if (bt.sharpe > 1 && bt.mdd < 0.3 && A.lastActiveDays < 7) { verdict = "可以跟单"; vcls = "pos"; }
  if (bt.hybrid) reasons.push(`${fmtD(bt.simStart)} 之前只能按官方收益等比换算（TWAP 明细已被 API 清除），早期曲线未计跟单摩擦`);
  if (A.hhi > 0.25) reasons.push(`持仓高度集中（HHI ${A.hhi.toFixed(2)}），跟单等于单票重仓风险`);
  if (A.lastActiveDays > 14) { verdict = "不建议跟单"; vcls = "neg"; reasons.push("地址已停止交易"); }
  if (A.twapShare > 0.3) reasons.push("重度 TWAP 执行：实际跟单会有分钟级延迟，成交价可能劣于模拟");
  if (bt.maxLev > 3) reasons.push(`峰值杠杆约 ${bt.maxLev.toFixed(1)}x，注意强平风险（模拟未含强平）`);
  if (A.ageDays < 120) reasons.push(`历史仅 ${A.ageDays.toFixed(0)} 天，样本不足`);
  if (!reasons.length) reasons.push("各项风险指标未见明显红旗，但历史业绩不代表未来");
  A.verdict = verdict; A.vcls = vcls; A.reasons = reasons;

  /* 地址所属推断 */
  const owner = [];
  if (D.vault) owner.push(`HL 金库「${(D.vault.name || "未命名")}」，管理他人资金`);
  const [h0, h1] = A.activeWindowUTC;
  const zone = h0 >= 12 && h0 <= 16 ? "美股时段（美洲/欧洲人？）" : h0 >= 0 && h0 <= 4 ? "亚洲时段（东亚人？）" : "全天分散（机器人或跨时区团队？）";
  owner.push(`最活跃时段 UTC ${h0}:00–${h1}:00（占 ${(A.activeWindowShare*100).toFixed(0)}% 成交量）→ ${zone}`);
  if (A.topCoins.some(([c]) => c.includes(":"))) owner.push("主战场是 HIP-3 股票/商品市场，而非主流币——熟悉传统市场标的");
  owner.push(A.twapShare > 0.2 ? "用 TWAP 拆单、控制冲击成本——专业执行习惯" : "以直接下单为主");
  if (D.truncated) owner.push("成交超过 API 保留上限(1万笔)，更早历史被截断");
  A.owner = owner;
  return A;
}

/* ---------- 图表 ---------- */
const GRID = "#1a2b25", MUT = "#7e968c", MINT = "#3fd9a4", AMBER = "#d9a441";
function setup(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = +cv.getAttribute("height");
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}
function downsample(pts, n) {
  if (pts.length <= n) return pts;
  const step = pts.length / n, out = [];
  for (let i = 0; i < n; i++) {
    const seg = pts.slice(Math.floor(i * step), Math.max(Math.floor((i + 1) * step), Math.floor(i * step) + 1));
    let mn = seg[0], mx = seg[0];
    for (const p of seg) { if (p[1] < mn[1]) mn = p; if (p[1] > mx[1]) mx = p; }
    out.push(mn === mx ? mn : (mn[0] < mx[0] ? mn : mx));
    if (mn !== mx) out.push(mn[0] < mx[0] ? mx : mn);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function drawEq(bt) {
  const cv = $("eqChart"), [ctx, W, H] = setup(cv);
  ctx.clearRect(0, 0, W, H);
  const pts = downsample(bt.curve, 2200);
  const PL = 62, PR = 14, PT = 14, PB = 68, DH = 40;
  const x0 = pts[0][0], x1 = pts[pts.length-1][0];
  let lo = Infinity, hi = -Infinity, peak = -Infinity;
  const dds = [];
  for (const [, e] of pts) { lo = Math.min(lo, e); hi = Math.max(hi, e); peak = Math.max(peak, e); dds.push(peak > 0 ? (peak - e) / peak : 0); }
  const pad = (hi - lo) * .07 || 1; lo -= pad; hi += pad;
  const X = t => PL + (t - x0) / (x1 - x0) * (W - PL - PR);
  const Y = v => PT + (hi - v) / (hi - lo) * (H - PT - PB - DH - 12);
  const maxdd = Math.max(...dds, 0.01);
  ctx.font = "11px ui-monospace,Menlo,monospace";
  for (let i = 0; i <= 5; i++) {
    const v = lo + (hi - lo) * i / 5, y = Y(v);
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.fillStyle = MUT; ctx.textAlign = "right"; ctx.fillText("$" + Math.round(v / 1000) + "k", PL - 8, y + 4);
  }
  ctx.textAlign = "center";
  const nlab = Math.min(7, Math.floor(W / 130));
  for (let i = 0; i <= nlab; i++) { const t = x0 + (x1 - x0) * i / nlab; ctx.fillText(fmtD(t), X(t), H - PB + DH + 22); }
  ctx.strokeStyle = "#3a5c50"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(PL, Y(F0)); ctx.lineTo(W - PR, Y(F0)); ctx.stroke(); ctx.setLineDash([]);
  if (bt.cliff) {
    const xc = X(bt.cliff);
    ctx.strokeStyle = AMBER; ctx.setLineDash([3, 5]); ctx.globalAlpha = .7;
    ctx.beginPath(); ctx.moveTo(xc, PT); ctx.lineTo(xc, H - PB); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = AMBER; ctx.textAlign = "left"; ctx.font = "10.5px ui-monospace,Menlo,monospace";
    ctx.fillText("官方收益换算 ←|→ 逐笔精确模拟", Math.max(xc - 118, PL + 2), PT + 12);
    ctx.font = "11px ui-monospace,Menlo,monospace";
  }
  const grad = ctx.createLinearGradient(0, PT, 0, H - PB - DH + 28);
  grad.addColorStop(0, "rgba(63,217,164,.22)"); grad.addColorStop(1, "rgba(63,217,164,0)");
  ctx.beginPath(); ctx.moveTo(X(x0), Y(pts[0][1]));
  for (const [t, e] of pts) ctx.lineTo(X(t), Y(e));
  ctx.lineTo(X(x1), H - PB - DH + 28); ctx.lineTo(X(x0), H - PB - DH + 28); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); ctx.strokeStyle = MINT; ctx.lineWidth = 1.8;
  pts.forEach(([t, e], i) => i ? ctx.lineTo(X(t), Y(e)) : ctx.moveTo(X(t), Y(e)));
  ctx.stroke(); ctx.lineWidth = 1;
  const dTop = H - PB;
  ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, dTop); ctx.lineTo(W - PR, dTop); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(x0), dTop);
  pts.forEach(([t], i) => ctx.lineTo(X(t), dTop + dds[i] / maxdd * (DH - 4)));
  ctx.lineTo(X(x1), dTop); ctx.closePath();
  ctx.fillStyle = "rgba(224,104,92,.35)"; ctx.fill();
  ctx.fillStyle = MUT; ctx.textAlign = "left";
  ctx.fillText("回撤 0 → −" + (maxdd * 100).toFixed(0) + "%", PL + 4, dTop + DH);
  const le = pts[pts.length-1];
  ctx.fillStyle = MINT; ctx.beginPath(); ctx.arc(X(le[0]), Y(le[1]), 3.5, 0, 7); ctx.fill();
  ctx.textAlign = "right"; ctx.fillText(money(le[1]), W - PR - 2, Y(le[1]) - 10);
  cv.onmousemove = ev => {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left;
    let bi = 0, bd = 1e18;
    for (let i = 0; i < pts.length; i++) { const d = Math.abs(X(pts[i][0]) - mx); if (d < bd) { bd = d; bi = i; } }
    const tip = $("tip");
    tip.style.display = "block";
    tip.style.left = Math.min(ev.clientX + 14, innerWidth - 180) + "px"; tip.style.top = (ev.clientY - 10) + "px";
    tip.innerHTML = fmtD(pts[bi][0]) + "<br><b style='color:" + MINT + "'>" + money(pts[bi][1]) + "</b> dd −" + (dds[bi] * 100).toFixed(1) + "%";
  };
  cv.onmouseleave = () => $("tip").style.display = "none";
}
function drawLd(A, D) {
  const cv = $("ldChart"), [ctx, W, H] = setup(cv);
  ctx.clearRect(0, 0, W, H);
  const pnl = A.pnlCurve;
  const eqm = {};
  for (const k of ["perpAllTime", "perpMonth", "perpWeek", "perpDay"])
    for (const [t, v] of ((D.portfolio[k] || {}).accountValueHistory || [])) eqm[+t] = parseFloat(v);
  const eq = Object.entries(eqm).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]);
  if (!pnl.length) return;
  const PL = 66, PR = 62, PT = 14, PB = 34;
  const x0 = pnl[0][0], x1 = pnl[pnl.length-1][0];
  let plo = 0, phi = 0, ehi = 0;
  for (const [, v] of pnl) { plo = Math.min(plo, v); phi = Math.max(phi, v); }
  for (const [, v] of eq) ehi = Math.max(ehi, v);
  phi = phi * 1.08 || 1; plo = plo * 1.15; ehi = ehi * 1.08 || 1;
  const X = t => PL + (t - x0) / (x1 - x0) * (W - PL - PR);
  const YP = v => PT + (phi - v) / (phi - plo) * (H - PT - PB);
  const YE = v => PT + (ehi - v) / ehi * (H - PT - PB);
  ctx.font = "11px ui-monospace,Menlo,monospace";
  const fm = v => (v < 0 ? "−" : "") + "$" + (Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(v) / 1000) + "k");
  for (let i = 0; i <= 5; i++) {
    const v = plo + (phi - plo) * i / 5, y = YP(v);
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.fillStyle = MUT; ctx.textAlign = "right"; ctx.fillText(fm(v), PL - 8, y + 4);
    const ev2 = ehi * i / 5;
    ctx.textAlign = "left"; ctx.fillStyle = "#8a7434"; ctx.fillText(fm(ev2), W - PR + 8, YE(ev2) + 4);
  }
  ctx.fillStyle = MUT; ctx.textAlign = "center";
  const nlab = Math.min(8, Math.floor(W / 120));
  for (let i = 0; i <= nlab; i++) { const t = x0 + (x1 - x0) * i / nlab; ctx.fillText(fmtD(t).slice(0, 7), X(t), H - PB + 22); }
  ctx.strokeStyle = "#3a5c50"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(PL, YP(0)); ctx.lineTo(W - PR, YP(0)); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.strokeStyle = "rgba(217,164,65,.75)"; ctx.lineWidth = 1.2;
  eq.forEach(([t, v], i) => i ? ctx.lineTo(X(t), YE(v)) : ctx.moveTo(X(t), YE(v)));
  ctx.stroke();
  ctx.beginPath(); ctx.strokeStyle = MINT; ctx.lineWidth = 1.8;
  pnl.forEach(([t, v], i) => i ? ctx.lineTo(X(t), YP(v)) : ctx.moveTo(X(t), YP(v)));
  ctx.stroke(); ctx.lineWidth = 1;
  const lp = pnl[pnl.length-1];
  ctx.fillStyle = MINT; ctx.beginPath(); ctx.arc(X(lp[0]), YP(lp[1]), 3.5, 0, 7); ctx.fill();
  ctx.textAlign = "right"; ctx.fillText(money(lp[1]), X(lp[0]) - 8, YP(lp[1]) - 8);
}

/* ---------- 渲染 ---------- */
function barRows(pairs) {
  if (!pairs.length) return '<div class="sub" style="padding:8px 0">无数据</div>';
  const mx = Math.max(...pairs.map(([, v]) => Math.abs(v))) || 1;
  return pairs.map(([k, v]) =>
    `<div class="crow"><div class="cname">${k}</div>
     <div class="cbar"><div class="cfill ${v >= 0 ? "pos" : "neg"}" style="width:${Math.abs(v) / mx * 100}%"></div></div>
     <div class="cnum ${v >= 0 ? "pos" : "neg"}">${money(v, true)}</div></div>`).join("");
}
function render(addr, D, bt, A) {
  const short = addr.slice(0, 6) + "…" + addr.slice(-4);
  document.title = `HL 跟单雷达 · ${short}`;
  // 结论卡
  const chips = A.tags.map(([t, cls, tip]) => `<span class="chip ${cls}" title="${tip}">${t}</span>`).join("") || '<span class="chip">无显著标签</span>';
  $("verdict").innerHTML = `
    <div class="vcard">
      <div class="addr"><a href="https://app.hyperliquid.xyz/explorer/address/${addr}">${addr}</a>
        · <a href="https://hypurrscan.io/address/${addr}">hypurrscan</a></div>
      <div class="chips">${chips}</div>
      <div class="verdictline">综合水平 <b>${A.grade}</b>（${A.score.toFixed(0)}/100） · 可跟单判定 <b class="${A.vcls}">${A.verdict}</b></div>
      <ul class="reasons">${A.reasons.map(r => `<li>${r}</li>`).join("")}</ul>
      <div class="sub" style="margin-top:10px">地址画像线索：${A.owner.join("；")}。</div>
    </div>`;
  // 统计卡
  const cards = [
    ["跟单终值", money(bt.final), `$100k 起 · ${(bt.days / 365).toFixed(1)} 年`, bt.final >= F0 ? "pos" : "neg"],
    ["总收益 / 年化", `${pct(bt.totalReturn)} / ${pct(bt.annReturn, 0)}`, bt.bankruptAt ? "中途爆仓" : (bt.hybrid && bt.simReturn != null ? `精确段(${fmtD(bt.simStart)}后) ${pct(bt.simReturn)}` : "全周期模拟"), bt.totalReturn >= 0 ? "pos" : "neg"],
    ["最大回撤", "−" + (bt.mdd * 100).toFixed(1) + "%", "低点 " + fmtD(bt.mddT), "neg"],
    ["Sharpe", bt.sharpe.toFixed(2), "小时收益年化", bt.sharpe > 0.5 ? "pos" : ""],
    ["地址官方累计 PnL", money(A.officialPnl, true), `当前权益 ${money(A.eqNow)}`, A.officialPnl >= 0 ? "pos" : "neg"],
    ["摩擦成本", money(-(bt.fees + bt.funding)), `手续费 ${money(bt.fees)} + 资金费${bt.funding > 0 ? "支出" : "收入"} ${money(Math.abs(bt.funding))}`, ""],
  ];
  $("cards").innerHTML = '<div class="cards">' + cards.map(([l, v, s, c]) =>
    `<div class="card"><div class="clabel">${l}</div><div class="cval ${c}">${v}</div><div class="csub">${s}</div></div>`).join("") + "</div>";
  $("copysub").innerHTML = (bt.hybrid
    ? `<b>两段式：</b>${fmtD(bt.simStart)} 之前 TWAP 明细已被 API 清除（缺口占比 ${(bt.preGapShare * 100).toFixed(0)}%），该段按官方 PnL/权益等比换算（未计跟单摩擦，前段收益 ${pct(bt.preReturn)}）；之后为逐笔精确模拟（段内收益 ${bt.simReturn != null ? pct(bt.simReturn) : "—"}）。`
    : `全程逐笔精确模拟。`) +
    ` 每当该地址有成交（含 TWAP 切片），跟单账户按「自身权益 / 他的权益」等比调整到相同目标仓位；精确段共复制 ${bt.nTrades.toLocaleString()} 次调仓，名义 ${money(bt.tradeNtl)}。`;
  // 月度收益
  const byMo = new Map();
  for (const [t, e] of bt.curve) {
    const m = fmtMo(t);
    if (!byMo.has(m)) byMo.set(m, [e, e]);
    byMo.get(m)[1] = e;
  }
  const mrows = [...byMo.entries()].map(([m, [a, b]]) => [m, a > 0 ? b / a - 1 : 0]);
  $("monthly").innerHTML = '<table class="mtable"><tr><th>月份</th><th>收益</th><th>月份</th><th>收益</th></tr>' +
    Array.from({length: Math.ceil(mrows.length / 2)}, (_, i) => {
      const a = mrows[i * 2], b = mrows[i * 2 + 1];
      const cell = x => x ? `<td>${x[0]}</td><td class="${x[1] >= 0 ? "pos" : "neg"}">${pct(x[1])}</td>` : "<td></td><td></td>";
      return "<tr>" + cell(a) + cell(b) + "</tr>";
    }).join("") + "</table>";
  // 分市场
  $("coinpnl").innerHTML = barRows(Object.entries(bt.coinFlow).sort((a, b) => b[1] - a[1]).slice(0, 12));
  // 风格指标
  const kv = [
    ["历史 / 活跃天数", `${A.ageDays.toFixed(0)} / ${A.activeDays} 天`],
    ["最近活跃", A.lastActiveDays < 1 ? "今天" : A.lastActiveDays.toFixed(0) + " 天前"],
    ["perp 成交笔数 / 名义", `${D.perp.length.toLocaleString()} / ${money(A.ntl)}`],
    ["TWAP 占比 / Maker 占比", `${(A.twapShare * 100).toFixed(0)}% / ${(A.makerShare * 100).toFixed(0)}%`],
    ["市场数 / 集中度 HHI", `${A.nCoins} / ${A.hhi.toFixed(2)}`],
    ["回合数 / 胜率 / 盈亏比", A.nEpisodes ? `${A.nEpisodes} / ${(A.winRate * 100).toFixed(0)}% / ${A.profitFactor.toFixed(1)}` : "—"],
    ["中位持仓时长", A.medianHoldH ? (A.medianHoldH > 48 ? (A.medianHoldH / 24).toFixed(1) + " 天" : A.medianHoldH.toFixed(0) + " 小时") : "—"],
    ["做多回合占比", A.longShare != null ? (A.longShare * 100).toFixed(0) + "%" : "—"],
    ["入场后24h胜率(择时)", A.entryHit24 != null ? `${(A.entryHit24 * 100).toFixed(0)}%（n=${A.entryN}）` : "样本不足"],
    ["平均 / 峰值杠杆(模拟)", `${bt.avgLev.toFixed(1)}x / ${bt.maxLev.toFixed(1)}x`],
    ["主力市场", A.topCoins.map(([c, n]) => `${c} ${(n / A.ntl * 100).toFixed(0)}%`).join(" · ")],
  ];
  $("stylemetrics").innerHTML = '<div class="kv">' + kv.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join("") + "</div>";
  const styleRead = [];
  styleRead.push(A.twapShare > 0.2
    ? `<b>执行方式：</b>${(A.twapShare * 100).toFixed(0)}% 的量用 TWAP 算法拆单，说明单笔目标仓位远大于盘口深度——专业/机构式操作。`
    : `<b>执行方式：</b>以直接下单为主。`);
  styleRead.push(A.hhi > 0.25
    ? `<b>风格：</b>集中重仓（前${Math.min(3, A.topCoins.length)}大市场占 ${(A.topCoins.slice(0, 3).reduce((s, [, n]) => s + n, 0) / A.ntl * 100).toFixed(0)}%），一次押一个题材，靠择时而非分散。属于<b>主观方向型</b>交易。`
    : `<b>风格：</b>多市场分散，${A.fillsPerActiveDay > 80 ? "高频调仓，接近量化组合运作" : "中低频轮动"}。`);
  const [h0, h1] = A.activeWindowUTC;
  styleRead.push(`<b>作息：</b>成交集中在 UTC ${h0}:00–${h1}:00（占 ${(A.activeWindowShare * 100).toFixed(0)}%），周末占比 ${(A.weekendShare * 100).toFixed(0)}%。`);
  if (A.entryHit24 != null) styleRead.push(`<b>择时：</b>入场后 24 小时方向胜率 ${(A.entryHit24 * 100).toFixed(0)}%（${A.entryN} 次），中位数 ${pct(A.entryFwdMed || 0, 2)}。${A.entryHit24 >= 0.65 ? "显著高于随机，存在信息或择时优势的统计迹象（无法区分来源）。" : "与随机差异不大，收益更多来自持仓管理而非入场点。"}`);
  $("styleread").innerHTML = styleRead.map(s => `<p style="margin:6px 0">${s}</p>`).join("");
  // 口径
  const gapShare = (bt.resyncNtl + bt.phantomNtl) / Math.max(bt.tradeNtl, 1);
  $("caveatbody").innerHTML = `<ul>
    <li><b>数据源：</b>Hyperliquid 公开 info API，浏览器现场拉取：userFillsByTime + userTwapSliceFillsByTime + fundingHistory + candleSnapshot + portfolio + clearinghouseState（含 HIP-3 各 dex）。</li>
    <li><b>TWAP 限制与两段拼接：</b>TWAP 切片明细只保留约最近 2 个月${D.twapEarliest ? `（本地址最早可见 ${fmtD(D.twapEarliest)}）` : ""}。${bt.hybrid ? `更早时段无法逐笔还原（仓位链缺口占比 ${(bt.preGapShare * 100).toFixed(0)}%），因此 <b>${fmtD(bt.simStart)} 之前的曲线用官方 PnL 按权益等比换算</b>（真实业绩、但未计跟单手续费/滑点），之后才是逐笔模拟。` : "本地址缺口很小，全程逐笔模拟。"}逐笔段内仍有 ${bt.nResync} 次小缺口对齐（名义 ${money(bt.resyncNtl)}）和 ${bt.nPhantom} 个合成平仓（名义 ${money(bt.phantomNtl)}）。</li>
    <li><b>成交假设：</b>按该地址成交 VWAP ± ${SLIP_BPS}bp 滑点成交，收 ${FEE_BPS}bp taker 费；未模拟跟单延迟与强平。</li>
    <li><b>标记价格：</b>近 200 天用 1h K线，更早用 1d K线 + 成交价兜底（HL 每周期只保留约 5000 根K线）。</li>
    <li><b>未包含：</b>现货成交 ${D.spotFills} 笔未复制；${D.truncated ? "<b>成交历史超过 API 1 万笔上限，最早期已截断；</b>" : ""}官方累计 PnL 曲线为 portfolio 端点原始数据，不受以上近似影响。</li>
  </ul>`;
  $("report").classList.remove("hidden");
}

/* ---------- 主流程 ---------- */
let running = false;
async function run(addr) {
  addr = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { alert("请输入合法的 0x 地址"); return; }
  if (running) return;
  running = true;
  $("go").disabled = true; $("go").textContent = "分析中…";
  $("progress").classList.remove("hidden");
  $("report").classList.add("hidden");
  $("plog").innerHTML = "";
  history.replaceState(null, "", "?address=" + addr);
  try {
    const D = await fetchAll(addr);
    if (!D.perp || !D.perp.length) { log("该地址没有可见的 perp 成交记录，无法回测。", "err"); return; }
    log("重建仓位并回测…");
    await sleep(30);
    const bt = runBacktest(D);
    const A = analyze(D, bt);
    render(addr, D, bt, A);
    drawEq(bt); drawLd(A, D);
    const redraw = () => { drawEq(bt); drawLd(A, D); };
    window.onresize = redraw;
    log("完成 ✓", "ok");
  } catch (e) {
    console.error(e);
    log("出错：" + (e && e.message || e), "err");
  } finally {
    running = false;
    $("go").disabled = false; $("go").textContent = "开始分析";
  }
}
$("go").onclick = () => run($("addr").value);
$("addr").addEventListener("keydown", e => { if (e.key === "Enter") run($("addr").value); });
document.querySelectorAll(".ex").forEach(a => a.onclick = e => { e.preventDefault(); $("addr").value = a.textContent; run(a.textContent); });
const q = new URLSearchParams(location.search).get("address");
if (q) { $("addr").value = q; run(q); }
