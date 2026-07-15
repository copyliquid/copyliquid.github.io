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

/* HL 按 IP 限权重(约1200/分钟)。主动限速, 避免 429 螺旋 */
const RATE_CAP = 1150;
const ledger = [];
async function withBudget(w) {
  let warned = false;
  while (true) {
    const now = Date.now();
    while (ledger.length && now - ledger[0][0] > 60_000) ledger.shift();
    const used = ledger.reduce((s, x) => s + x[1], 0);
    if (used + w <= RATE_CAP) { ledger.push([Date.now(), w]); return; }
    if (!warned && Date.now() - (withBudget.lastLog || 0) > 15_000) {
      withBudget.lastLog = Date.now(); warned = true;
      log("已达 API 每分钟配额，排队中…（大地址属正常，请耐心）");
    }
    await sleep(400);
  }
}
async function post(body, tries, weight) {
  tries = tries || 4;
  weight = weight || 20;
  for (let i = 0; i < tries; i++) {
    await withBudget(weight);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort("timeout"), 25000);
    try {
      const r = await fetch(API, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: ctl.signal});
      if (r.status === 429) { log(`触发限流，等 ${10*(i+1)}s…`); await sleep(10000*(i+1)); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      log(`请求失败(${e.name === "AbortError" ? "超时" : (e.message || e)})，重试 ${i+1}/${tries-1}…`);
      await sleep(1500 * (i + 1));
    } finally { clearTimeout(to); }
  }
}

/* ---------- 数据拉取 ---------- */
async function fetchPaged(mk, getTime, label, maxPages) {
  maxPages = maxPages || 60;
  const seen = new Set(), out = [];
  out.capped = false;
  let start = 0; const now = Date.now();
  for (let page = 0; page < maxPages; page++) {
    if (page === maxPages - 1) out.capped = true;
    const batch = await post(mk(start, now), 4, 20);
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
    await sleep(50);
  }
  return out;
}


/* 每个 coin 的实际持仓时段 (顺序无关重放, 间隔<3天合并, pad±6h) */
function heldSpans(perp) {
  const by = {};
  for (const f of perp) (by[f.coin] = by[f.coin] || []).push(f);
  const out = {}; const now = Date.now();
  for (const [c, fs] of Object.entries(by)) {
    const groups = new Map();
    for (const f of fs) { if (!groups.has(f.time)) groups.set(f.time, []); groups.get(f.time).push(f); }
    let pos = null, openT = null; const spans = [];
    for (const [t, g] of [...groups.entries()].sort((x, y) => x[0] - y[0])) {
      const sps = g.map(f => parseFloat(f.startPosition));
      if (pos === null) pos = sps.reduce((p, q) => Math.abs(q) < Math.abs(p) ? q : p, sps[0]);
      else if (!sps.some(sp => Math.abs(pos - sp) <= Math.max(1e-3, Math.abs(sp) * 1e-5)))
        pos = sps.reduce((p, q) => Math.abs(q - pos) < Math.abs(p - pos) ? q : p);
      const delta = g.reduce((s, f) => s + parseFloat(f.sz) * (f.side === "B" ? 1 : -1), 0);
      const before = pos; pos += delta;
      if (Math.abs(pos) < 1e-9) pos = 0;
      if (openT === null && (Math.abs(before) > 1e-9 || Math.abs(pos) > 1e-9)) openT = t;
      if (openT !== null && pos === 0) { spans.push([openT, t]); openT = null; }
    }
    if (openT !== null) spans.push([openT, now]);
    const merged = [];
    for (const [s, e] of spans) {
      if (merged.length && s - merged[merged.length - 1][1] < 3 * DAY)
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      else merged.push([s, e]);
    }
    out[c] = merged.map(([s, e]) => [s - 6 * HOUR, Math.min(e + 6 * HOUR, now)]);
  }
  return out;
}

async function fetchAll(addr) {
  const D = {};
  log("拉取账户概况…");
  D.portfolio = Object.fromEntries(await post({type: "portfolio", user: addr}));
  D.vault = await post({type: "vaultDetails", vaultAddress: addr}).catch(() => null);
  await sleep(120);
  D.spot = await post({type: "spotClearinghouseState", user: addr}, 4, 2).catch(() => null);

  log("拉取成交记录…");
  D.fills = await fetchPaged(
    (s, n) => ({type: "userFillsByTime", user: addr, startTime: s, endTime: n, aggregateByTime: false}),
    b => b.time, "普通成交", 15);  // 权重见 post 调用
  if (D.fills.capped || D.fills.length >= 28000) {   // 页数打满≈3万笔: 高频/做市账户
    D.hft = true;
    D.all = D.fills; D.twaps = [];
    D.perp = D.fills.filter(f => !f.coin.startsWith("@") && !f.coin.includes("/"));
    D.spotFills = D.all.length - D.perp.length;
    log("检测到高频/做市型账户（成交 ≥3 万笔），跳过逐笔回测，改为概要报告", "err");
    return D;
  }
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
    const st = await post(dx ? {type: "clearinghouseState", user: addr, dex: dx} : {type: "clearinghouseState", user: addr}, 4, 2);
    D.eqNow += parseFloat(st.marginSummary.accountValue);
    for (const p of st.assetPositions || []) D.actual[p.position.coin] = parseFloat(p.position.szi);
    await sleep(120);
  }

  // 实际持仓时段 (只为这些区间拉行情)
  const now = Date.now();
  const spans = heldSpans(D.perp);
  // 市场太多时只保留成交名义前 25
  const ntlByCoin = {};
  for (const f of D.perp) ntlByCoin[f.coin] = (ntlByCoin[f.coin] || 0) + parseFloat(f.px) * parseFloat(f.sz);
  const allCoins = Object.keys(spans);
  if (allCoins.length > 25) {
    const keep = new Set(Object.entries(ntlByCoin).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([c]) => c));
    for (const c of allCoins) if (!keep.has(c)) delete spans[c];
    D.coinCapped = allCoins.length;
    log(`市场多达 ${allCoins.length} 个，只对成交额前 25 拉行情，其余用成交价标记`);
  }
  // 预估请求量
  let planned = 0;
  for (const [c, ss] of Object.entries(spans)) {
    for (const [s, e] of ss) {
      if (e > now - 199 * DAY) planned++;                       // 1h K线
      planned += Math.min(Math.ceil((e - s) / (480 * HOUR)), 4); // 资金费
    }
    if (ss.length && ss[0][0] < now - 195 * DAY) planned++;      // 1d K线
  }
  log(`开始拉行情与资金费（约 ${planned} 个请求，大地址请耐心）…`);

  // K线: 每个持仓时段一次 1h 调用(近200天内), 老时段整窗一次 1d
  D.candles = {};
  const nCoin = Object.keys(spans).length; let wi = 0;
  for (const [c, ss] of Object.entries(spans)) {
    wi++; if (wi % 5 === 0) log(`K线进度 ${wi}/${nCoin}（${c}）`);
    const px = {};
    if (ss.length && ss[0][0] < now - 195 * DAY) {
      const d1 = await post({type: "candleSnapshot", req: {coin: c, interval: "1d",
        startTime: ss[0][0], endTime: ss[ss.length - 1][1]}}, 4, 15).catch(() => []);
      for (const r of d1 || []) px[r.t + DAY] = parseFloat(r.c);
    }
    for (const [s, e] of ss) {
      if (e <= now - 199 * DAY) continue;
      const h1 = await post({type: "candleSnapshot", req: {coin: c, interval: "1h",
        startTime: Math.max(s, now - 199 * DAY), endTime: e}}, 4, 15).catch(() => []);
      for (const r of h1 || []) px[r.t + HOUR] = parseFloat(r.c);
    }
    D.candles[c] = px;
  }
  // 资金费: 只拉持仓时段, 每段最多4页
  D.funding = {};
  wi = 0;
  for (const [c, ss] of Object.entries(spans)) {
    wi++; if (wi % 5 === 0) log(`资金费进度 ${wi}/${nCoin}（${c}）`);
    const rows = [];
    for (const [s0, e] of ss) {
      let s = s0;
      for (let p = 0; p < 4; p++) {
        const b = await post({type: "fundingHistory", coin: c, startTime: s, endTime: e}, 4, 15).catch(() => []);
        if (!Array.isArray(b) || !b.length) break;
        for (const r of b) rows.push([r.time, parseFloat(r.fundingRate)]);
        const last = b[b.length - 1].time;
        if (last <= s || last >= e || b.length < 400) break;
        s = last + 1;
      }
    }
    rows.sort((x, y) => x[0] - y[0]);
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
function eqPairsOf(D) {
  const eqm = {};
  for (const k of ["perpAllTime", "perpMonth", "perpWeek", "perpDay"])
    for (const [t, v] of ((D.portfolio[k] || {}).accountValueHistory || [])) eqm[+t] = parseFloat(v);
  return Object.entries(eqm).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]);
}
function drawLd(pnl, eq) {
  const cv = $("ldChart"), [ctx, W, H] = setup(cv);
  ctx.clearRect(0, 0, W, H);
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
    <li><b>未包含：</b>现货成交 ${D.spotFills} 笔未复制；${D.coinCapped ? `交易市场多达 ${D.coinCapped} 个，仅前 25 大拉取了 K 线/资金费，其余用成交价标记；` : ""}${D.truncated ? "<b>成交历史超过 API 1 万笔上限，最早期已截断；</b>" : ""}官方累计 PnL 曲线为 portfolio 端点原始数据，不受以上近似影响。</li>
  </ul>`;
  for (const id of ["copysec", "tables", "stylesec", "caveats", "leadersec"]) { const el = $(id); if (el) el.classList.remove("hidden"); }
  $("report").classList.remove("hidden");
}

/* ---------- 高频账户概要报告 ---------- */
function renderHFT(addr, D) {
  const short = addr.slice(0, 6) + "…" + addr.slice(-4);
  document.title = `Copyliquid · ${short}`;
  const pnl = buildLeaderPnl(D);
  const officialPnl = pnl.length ? pnl[pnl.length - 1][1] : 0;
  const port = D.portfolio.perpAllTime || {};
  const vlm = parseFloat(port.vlm || 0);
  const avh = (port.accountValueHistory || []);
  const eqNow = avh.length ? parseFloat(avh[avh.length - 1][1]) : 0;
  const moRoi = (() => {
    const m = (D.portfolio.perpMonth || {}).pnlHistory || [];
    if (!m.length) return null;
    const dp = parseFloat(m[m.length - 1][1]) - parseFloat(m[0][1]);
    return eqNow > 0 ? dp / eqNow : null;
  })();
  const chips = [`<span class="chip red">高频 / 做市</span>`];
  if (eqNow > 1e6 || vlm > 5e7) chips.push(`<span class="chip mint">巨鲸</span>`);
  $("verdict").innerHTML = `
    <div class="vcard">
      <div class="addr"><a href="https://app.hyperliquid.xyz/explorer/address/${addr}">${addr}</a>
        · <a href="https://hypurrscan.io/address/${addr}">hypurrscan</a></div>
      <div class="chips">${chips.join("")}</div>
      <div class="verdictline">可跟单判定 <b class="neg">不可跟单（高频/做市型）</b></div>
      <ul class="reasons">
        <li>可见成交已达 ${D.fills.length.toLocaleString()} 笔（API 上限内仍未拉完），为高频/做市式操作</li>
        <li>此类账户盈利依赖毫秒级执行与返佣，人工或跟单系统复制后成本结构完全不同，逐笔回测无意义</li>
        <li>下方仅展示其官方累计 PnL 与权益概要</li>
      </ul>
    </div>`;
  const cards = [
    ["官方累计 PnL", money(officialPnl, true), "perp 全周期", officialPnl >= 0 ? "pos" : "neg"],
    ["当前权益", money(eqNow), "", ""],
    ["30 天收益率", moRoi != null ? pct(moRoi) : "—", "官方口径", moRoi >= 0 ? "pos" : "neg"],
    ["全时段成交量", money(vlm), `可见成交 ${D.fills.length.toLocaleString()}+ 笔`, ""],
  ];
  $("cards").innerHTML = '<div class="cards">' + cards.map(([l, v, s, c]) =>
    `<div class="card"><div class="clabel">${l}</div><div class="cval ${c}">${v}</div><div class="csub">${s}</div></div>`).join("") + "</div>";
  for (const id of ["copysec", "tables", "stylesec", "caveats"]) { const el = $(id); if (el) el.classList.add("hidden"); }
  $("leadersec").classList.remove("hidden");
  $("report").classList.remove("hidden");
}

/* ---------- 主流程 ---------- */
let running = false;
const DATA_BASE = "https://copyliquid.github.io/data";
const IS_PRECOMPUTE = new URLSearchParams(location.search).has("precompute");
async function tryPrecomputed(addr) {
  if (IS_PRECOMPUTE) return false;
  try {
    const r = await fetch(`${DATA_BASE}/addr/${addr}.json`, {cache: "no-cache"});
    if (!r.ok) return false;
    const p = await r.json();
    if (!p.html) return false;
    $("report").innerHTML = p.html;
    $("report").classList.remove("hidden");
    const redraw = () => {
      if (p.eqc && $("eqChart")) drawEq(p.eqc);
      if (p.ld && $("ldChart")) drawLd(p.ld.pnl, p.ld.eq);
    };
    redraw(); window.onresize = redraw;
    const age = Math.round((Date.now() - p.t) / 3600_000 * 10) / 10;
    log(`已加载预计算结果（${age} 小时前，由后台机器人算好） · <a href="#" id="freshLink" style="color:var(--mint)">点此现场重算最新数据</a>`, "ok");
    const fl = document.getElementById("freshLink");
    if (fl) fl.onclick = e => { e.preventDefault(); runLive(addr); };
    return true;
  } catch (e) { return false; }
}
async function run(addr) {
  addr = (addr || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { alert("请输入合法的 0x 地址"); return; }
  if (running) { log("上一个分析还在进行中，请等它完成后再点（页面同时只能分析一个地址）", "err"); return; }
  $("progress").classList.remove("hidden");
  $("plog").innerHTML = "";
  $("progress").scrollIntoView({behavior: "smooth", block: "start"});
  history.replaceState(null, "", "?address=" + addr);
  log("查询预计算缓存…");
  if (await tryPrecomputed(addr)) return;
  return runLive(addr);
}
async function runLive(addr) {
  if (running) return;
  running = true;
  $("go").disabled = true; $("go").textContent = "分析中…";
  $("progress").classList.remove("hidden");
  $("report").classList.add("hidden");
  $("plog").innerHTML = "";
  try {
    const D = await fetchAll(addr);
    if (!D.perp || !D.perp.length) { log("该地址没有可见的 perp 成交记录，无法回测。", "err"); return; }
    const eqPairs = eqPairsOf(D);
    if (D.hft) {
      renderHFT(addr, D);
      const pnlC = buildLeaderPnl(D);
      drawLd(pnlC, eqPairs);
      window.onresize = () => drawLd(pnlC, eqPairs);
      window.__RESULT = {v: 1, t: Date.now(), addr, html: $("report").innerHTML,
                         ld: {pnl: pnlC, eq: eqPairs}};
      log("完成（概要模式）✓", "ok");
      return;
    }
    log("重建仓位并回测…");
    await sleep(30);
    const bt = runBacktest(D);
    const A = analyze(D, bt);
    render(addr, D, bt, A);
    drawEq(bt); drawLd(A.pnlCurve, eqPairs);
    const redraw = () => { drawEq(bt); drawLd(A.pnlCurve, eqPairs); };
    window.onresize = redraw;
    window.__RESULT = {v: 1, t: Date.now(), addr, html: $("report").innerHTML,
                       eqc: {curve: downsample(bt.curve, 2200), cliff: bt.cliff},
                       ld: {pnl: A.pnlCurve, eq: eqPairs}};
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

/* ---------- 发现优质地址 (官方排行榜筛选 + 深挖排序) ---------- */
const LB_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const LB_CACHE_KEY = "copyliquid_lb_v2", LB_TTL = 6 * HOUR;
let LB_ROWS = null, LB_SORT = "score";

async function fetchLeaderboard() {
  const st = $("lbstatus");
  try {
    const cached = JSON.parse(localStorage.getItem(LB_CACHE_KEY) || "null");
    if (cached && Date.now() - cached.t < LB_TTL) {
      st.textContent = `使用 ${Math.round((Date.now() - cached.t) / 60000)} 分钟前的缓存（每 6 小时自动刷新）`;
      return cached.rows;
    }
  } catch (e) {}
  const resp = await fetch(LB_URL);
  if (!resp.ok) throw new Error("排行榜下载失败 HTTP " + resp.status);
  const total = +resp.headers.get("Content-Length") || 33e6;
  const reader = resp.body.getReader();
  const chunks = []; let got = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    st.textContent = `下载官方排行榜… ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`;
  }
  st.textContent = "解析与初筛 40,000+ 地址…";
  await sleep(30);
  const buf = new Uint8Array(got); let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  const data = JSON.parse(new TextDecoder().decode(buf));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const pool = (data.leaderboardRows || data).map(r => {
    const w = Object.fromEntries(r.windowPerformances);
    const g = k => ({pnl: +w[k].pnl, roi: +w[k].roi, vlm: +w[k].vlm});
    return {a: r.ethAddress, name: r.displayName || "", av: +r.accountValue,
            wk: g("week"), mo: g("month"), at: g("allTime")};
  }).filter(r =>
      r.av >= 100_000 && r.mo.vlm >= 1e6 &&
      r.mo.vlm / r.av <= 300 &&                 // 排除做市/刷量
      r.at.pnl > 0 && r.mo.roi > -0.1 && r.wk.roi > -0.15)
    .map(r => ({...r, score:
      45 * clamp(r.mo.roi, 0, 1) +
      20 * clamp(r.wk.roi * 2, -1, 1) +
      25 * clamp(r.at.roi / 2, 0, 1) +
      10 * clamp(Math.log10(r.av / 1e5) / 2, 0, 1)}))
    .sort((x, y) => y.score - x.score)
    .slice(0, 55);

  // 深挖: 逐个拉 portfolio, 计算近半年/近1年指标 + 聪明钱/信息优势分
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    st.textContent = `深挖候选 ${i + 1}/${pool.length}（拉取全历史 PnL 曲线）…`;
    try {
      const port = Object.fromEntries(await post({type: "portfolio", user: pool[i].a}));
      out.push({...pool[i], ...enrichMetrics(port)});
    } catch (e) { out.push({...pool[i], ret6m: null}); }
  }
  try { localStorage.setItem(LB_CACHE_KEY, JSON.stringify({t: Date.now(), rows: out})); } catch (e) {}
  return out;
}

/* 从 portfolio 曲线计算: 近半年收益 / 近1年夏普 / 聪明钱分 / 信息优势分 */
function enrichMetrics(port) {
  const D0 = {portfolio: port};
  const pnl = buildLeaderPnl(D0);                       // [[t, 累计pnl]]
  const eqm = {};
  for (const k of ["perpAllTime", "perpMonth", "perpWeek", "perpDay"])
    for (const [t, v] of ((port[k] || {}).accountValueHistory || [])) eqm[+t] = parseFloat(v);
  const eqArr = Object.entries(eqm).map(([t, v]) => [+t, v]).sort((x, y) => x[0] - y[0]);
  if (pnl.length < 5 || !eqArr.length) return {ret6m: null};
  const now = pnl[pnl.length - 1][0];
  const interp = (arr, t) => {
    let i = arr.findIndex(x => x[0] > t);
    if (i === 0) return arr[0][1];
    if (i < 0) return arr[arr.length - 1][1];
    const w = (t - arr[i-1][0]) / (arr[i][0] - arr[i-1][0]);
    return arr[i-1][1] * (1 - w) + arr[i][1] * w;
  };
  const peakEq = Math.max(...eqArr.map(x => x[1]), 50_000);
  const eqAt = t => Math.max(interp(eqArr, t), peakEq * 0.15, 50_000);
  // 近半年 / 近1年收益 (Δpnl / 窗口起点权益)
  const ret = days => {
    const t0 = now - days * DAY;
    if (pnl[0][0] > t0 + 30 * DAY) return null;  // 历史不足
    return (pnl[pnl.length-1][1] - interp(pnl, t0)) / eqAt(t0);
  };
  const ret6m = ret(182), ret1y = ret(365);
  // 近1年夏普: 用 pnl 采样点的期间收益(Δpnl/当期权益), 按采样间隔年化
  const win = pnl.filter(([t]) => t >= now - 365 * DAY);
  const rets = [], dts = [];
  for (let i = 1; i < win.length; i++) {
    const dt = (win[i][0] - win[i-1][0]) / DAY;
    if (dt <= 0) continue;
    rets.push((win[i][1] - win[i-1][1]) / eqAt(win[i-1][0]));
    dts.push(dt);
  }
  let sharpe1y = null;
  if (rets.length >= 8) {
    const mu = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / rets.length);
    const avgDt = dts.reduce((s, d) => s + d, 0) / dts.length;
    sharpe1y = sd > 0 ? (mu / sd) * Math.sqrt(365 / avgDt) : null;
  }
  // pnl 曲线回撤 (相对峰值权益)
  let peak = -1e18, mdd = 0;
  for (const [, v] of pnl) { peak = Math.max(peak, v); mdd = Math.max(mdd, (peak - v) / peakEq); }
  // 盈利集中度: 前3大正跳占全部正收益之比 (信息/事件驱动特征)
  const pos = rets.filter(r => r > 0).sort((x, y) => y - x);
  const posSum = pos.reduce((s, r) => s + r, 0);
  const conc = posSum > 0 ? pos.slice(0, 3).reduce((s, r) => s + r, 0) / posSum : 0;
  const winShare = rets.length ? rets.filter(r => r > 0).length / rets.length : 0;
  const histDays = (now - pnl[0][0]) / DAY;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // 聪明钱分: 长期赚钱 + 风险调整后优 + 稳定
  const smart = Math.round(clamp(
    30 * clamp((ret1y == null ? (ret6m || 0) * 2 : ret1y) / 2, 0, 1) +
    30 * clamp((sharpe1y || 0) / 3, 0, 1) +
    20 * clamp(winShare * 1.6 - 0.5, 0, 1) +
    10 * clamp(1 - mdd / 0.6, 0, 1) +
    10 * clamp(histDays / 540, 0, 1), 0, 100));
  // 信息优势分(统计信号): 收益高度集中于少数几笔 + 胜率高 + 短史暴利加成
  const insider = Math.round(clamp(
    45 * clamp((conc - 0.4) / 0.5, 0, 1) +
    30 * clamp(winShare * 1.8 - 0.7, 0, 1) +
    25 * clamp(((ret6m || 0) - 0.5) / 2, 0, 1), 0, 100));
  return {ret6m, ret1y, sharpe1y, smart, insider, mdd, histDays: Math.round(histDays)};
}

const LB_SORTS = [
  ["score",   "综合(30天)",   r => r.score],
  ["ret6m",   "近半年收益",   r => r.ret6m ?? -9],
  ["sharpe1y","近1年夏普",    r => r.sharpe1y ?? -9],
  ["smart",   "聪明钱分",     r => r.smart ?? -9],
  ["insider", "信息优势分",   r => r.insider ?? -9],
];

function renderLB() {
  const rows = [...LB_ROWS].sort((x, y) => {
    const key = LB_SORTS.find(s => s[0] === LB_SORT)[2];
    return key(y) - key(x);
  }).slice(0, 30);
  const st = $("lbstatus");
  st.innerHTML = LB_SORTS.map(([k, label]) =>
    `<button class="sortbtn${k === LB_SORT ? " on" : ""}" data-k="${k}">${label}</button>`).join("") +
    `<span style="margin-left:12px">深挖了 ${LB_ROWS.length} 个初筛候选` +
    (LB_PRE_TS ? ` · 预计算于 ${Math.round((Date.now() - LB_PRE_TS) / 3600_000 * 10) / 10} 小时前 <a href="#" id="lbFresh" style="color:var(--mint)">现场重筛</a>` : "") +
    ` · 信息优势分仅为统计信号</span>`;
  const lf = document.getElementById("lbFresh");
  if (lf) lf.onclick = async e => {
    e.preventDefault();
    localStorage.removeItem(LB_CACHE_KEY);
    $("lbstatus").textContent = "现场重筛中…";
    LB_ROWS = await fetchLeaderboard(); LB_PRE_TS = null; renderLB();
  };
  const fm = v => (v < 0 ? "−" : "") + "$" + (Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(2) + "M" : Math.round(Math.abs(v) / 1e3) + "k");
  const fp = v => v == null ? "—" : `<span class="${v >= 0 ? "pos" : "neg"}">${(v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(0)}%</span>`;
  const fs = v => v == null ? "—" : `<span class="${v >= 1 ? "pos" : ""}">${v.toFixed(2)}</span>`;
  const fscore = v => v == null ? "—" : `<span class="${v >= 60 ? "pos" : v >= 30 ? "warn" : ""}">${v}</span>`;
  $("lbbody").innerHTML = `<table class="lbtable">
    <thead><tr><th>#&nbsp;&nbsp;地址</th><th>权益</th><th>30d ROI</th><th>近半年</th><th>近1年</th><th>夏普1Y</th><th>聪明钱</th><th>信息分</th><th>史长</th><th></th></tr></thead>
    <tbody>` + rows.map((r, i) => `
      <tr data-a="${r.a}">
        <td>${i + 1}&nbsp;&nbsp;<span title="${r.a}">${r.a.slice(0, 6)}…${r.a.slice(-4)}</span>${r.name ? `<span class="lbname">${r.name.slice(0, 14)}</span>` : ""}</td>
        <td>${fm(r.av)}</td><td>${fp(r.mo.roi)}</td><td>${fp(r.ret6m)}</td><td>${fp(r.ret1y)}</td>
        <td>${fs(r.sharpe1y)}</td><td>${fscore(r.smart)}</td><td>${fscore(r.insider)}</td>
        <td>${r.histDays ? r.histDays + "d" : "—"}</td>
        <td><button class="ana">分析</button></td>
      </tr>`).join("") + "</tbody></table>";
  document.querySelectorAll(".sortbtn").forEach(b =>
    b.onclick = e => { e.stopPropagation(); LB_SORT = b.dataset.k; renderLB(); });
  document.querySelectorAll("#lbbody tbody tr").forEach(tr =>
    tr.onclick = () => { const a = tr.dataset.a; $("addr").value = a; run(a); });
}

async function tryPrecomputedLB() {
  if (IS_PRECOMPUTE) return false;
  try {
    const r = await fetch(`${DATA_BASE}/leaderboard.json`, {cache: "no-cache"});
    if (!r.ok) return false;
    const p = await r.json();
    if (!Array.isArray(p.rows) || !p.rows.length) return false;
    LB_ROWS = p.rows; LB_PRE_TS = p.t;
    renderLB();
    return true;
  } catch (e) { return false; }
}
let LB_PRE_TS = null;
$("discover").onclick = async () => {
  const btn = $("discover");
  btn.disabled = true; btn.textContent = "筛选中…";
  $("discoverSec").classList.remove("hidden");
  try {
    if (!(await tryPrecomputedLB())) { LB_ROWS = await fetchLeaderboard(); LB_PRE_TS = null; renderLB(); }
    window.__LB = {v: 1, t: Date.now(), rows: LB_ROWS};
  }
  catch (e) { $("lbstatus").textContent = "出错：" + (e.message || e); }
  finally { btn.disabled = false; btn.textContent = "✦ 发现优质地址"; }
};
