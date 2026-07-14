import json, datetime

r = json.load(open("data/results.json"))
addr = r["address"]
short = addr[:6] + "…" + addr[-4:]
c = r["copy"]; L = r["leader"]; P = r["params"]

def fmt_d(ms): return datetime.datetime.fromtimestamp(ms/1000).strftime("%Y-%m-%d")
start_s, end_s = fmt_d(P["copy_start"]), fmt_d(P["end"])

# 压缩曲线数据
curve = [[t, round(e,1)] for t, e in c["curve"]]
lpnl  = L["pnl_curve"]; leq = L["eq_curve"]

coin_rows_copy = [(k, v) for k, v in c["coin_pnl"].items()]
coin_rows_leader = [(k, v) for k, v in L["closed_pnl_by_coin"].items() if abs(v) > 500]

DATA = json.dumps({"curve": curve, "lpnl": lpnl, "leq": leq}, separators=(",",":"))

def money(v, sign=False):
    s = f"{abs(v):,.0f}"
    return (("+" if v>=0 else "−") if sign else ("−" if v<0 else "")) + "$" + s

stat_cards = [
    ("最终净值", money(c["final"]), f"初始 $100,000", "pos" if c["final"]>=100000 else "neg"),
    ("总收益", f"{c['total_return']*100:+.1f}%", f"{c['days']:.0f} 天 · 年化 {c['ann_return']*100:+.0f}%", "pos" if c["total_return"]>=0 else "neg"),
    ("最大回撤", f"−{c['mdd']*100:.1f}%", f"低点 {fmt_d(c['mdd_t'])}", "neg"),
    ("Sharpe", f"{c['sharpe']:.2f}", "小时收益年化", "pos" if c["sharpe"]>0 else "neg"),
    ("跟单成交", f"{c['n_trades']:,}", f"名义 ${c['trade_ntl']/1e6:.1f}M", ""),
    ("摩擦成本", "", "", ""),
]
# funding_paid > 0 表示净支出 (cash -= pay)
fund = c["funding"]
friction = c["fees"] + fund
stat_cards[5] = ("摩擦成本", f"\u2212${friction:,.0f}",
                 f"手续费 ${c['fees']:,.0f} + 资金费" + ("净支出" if fund > 0 else "净收入") + f" ${abs(fund):,.0f}", "neg")

cards_html = ""
for label, val, sub, cls in stat_cards:
    cards_html += f'<div class="card"><div class="clabel">{label}</div><div class="cval {cls}">{val}</div><div class="csub">{sub}</div></div>'

def rows(pairs):
    out = ""
    mx = max(abs(v) for _, v in pairs) or 1
    for k, v in pairs:
        w = abs(v)/mx*100
        cls = "pos" if v >= 0 else "neg"
        out += f'''<div class="crow"><div class="cname">{k}</div>
<div class="cbar"><div class="cfill {cls}" style="width:{w:.1f}%"></div></div>
<div class="cnum {cls}">{money(v, True)}</div></div>'''
    return out

html = f"""<title>HL 跟单回测 · {short}</title>
<meta name="description" content="Hyperliquid 地址 {short} 跟单策略回测：净值曲线、回撤、成本与数据口径说明">
<style>
:root {{
  --bg:#0c1512; --panel:#111e1a; --panel2:#0f1a16; --line:#1e312b;
  --ink:#dcece5; --mut:#7e968c; --faint:#54685f;
  --mint:#3fd9a4; --red:#e0685c; --amber:#d9a441;
}}
* {{ box-sizing:border-box }}
body {{ background:var(--bg); color:var(--ink); font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  margin:0; padding:0 20px 80px; }}
.wrap {{ max-width:1060px; margin:0 auto }}
.mono {{ font-family:ui-monospace,"SF Mono",Menlo,monospace }}
header {{ padding:44px 0 10px; border-bottom:1px solid var(--line); margin-bottom:26px }}
.eyebrow {{ font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:.18em; color:var(--mint); text-transform:uppercase }}
h1 {{ font-size:26px; margin:10px 0 6px; font-weight:650; letter-spacing:-.01em; text-wrap:balance }}
.addr {{ font-family:ui-monospace,Menlo,monospace; font-size:13px; color:var(--mut); word-break:break-all }}
.addr a {{ color:var(--mint); text-decoration:none; border-bottom:1px dotted var(--faint) }}
.meta {{ display:flex; flex-wrap:wrap; gap:8px 22px; margin:14px 0 18px; font-size:13px; color:var(--mut) }}
.meta b {{ color:var(--ink); font-weight:600; font-family:ui-monospace,Menlo,monospace }}
h2 {{ font-size:15px; font-weight:650; margin:38px 0 4px; display:flex; align-items:baseline; gap:10px }}
h2 .tag {{ font-family:ui-monospace,Menlo,monospace; font-size:10.5px; letter-spacing:.14em; color:var(--faint); text-transform:uppercase; font-weight:500 }}
.sub {{ color:var(--mut); font-size:13px; margin:0 0 14px }}
.cards {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:10px }}
.card {{ background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:13px 15px 11px }}
.clabel {{ font-size:11px; letter-spacing:.1em; color:var(--mut); text-transform:uppercase; font-family:ui-monospace,Menlo,monospace }}
.cval {{ font-size:21px; font-weight:650; margin-top:5px; font-family:ui-monospace,Menlo,monospace; font-variant-numeric:tabular-nums }}
.csub {{ font-size:12px; color:var(--faint); margin-top:3px }}
.pos {{ color:var(--mint) }} .neg {{ color:var(--red) }}
.panel {{ background:var(--panel2); border:1px solid var(--line); border-radius:6px; padding:16px 16px 8px; }}
canvas {{ width:100%; display:block }}
.legend {{ display:flex; gap:18px; font-size:12px; color:var(--mut); padding:6px 2px 8px; font-family:ui-monospace,Menlo,monospace }}
.legend i {{ display:inline-block; width:14px; height:3px; border-radius:2px; vertical-align:middle; margin-right:6px }}
.cols {{ display:grid; grid-template-columns:1fr 1fr; gap:22px }}
@media (max-width:760px) {{ .cols {{ grid-template-columns:1fr }} }}
.crow {{ display:grid; grid-template-columns:110px 1fr 110px; gap:12px; align-items:center; padding:7px 2px; border-bottom:1px solid var(--line) }}
.crow:last-child {{ border-bottom:none }}
.cname {{ font-family:ui-monospace,Menlo,monospace; font-size:13px; color:var(--ink) }}
.cbar {{ height:10px; background:#15231e; border-radius:3px; overflow:hidden }}
.cfill {{ height:100% }} .cfill.pos {{ background:linear-gradient(90deg,#1f7d61,var(--mint)) }}
.cfill.neg {{ background:linear-gradient(90deg,#8a3d35,var(--red)) }}
.cnum {{ text-align:right; font-family:ui-monospace,Menlo,monospace; font-size:13px; font-variant-numeric:tabular-nums }}
.note {{ background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--amber); border-radius:6px;
  padding:14px 18px; font-size:13.5px; color:var(--mut); margin:12px 0 }}
.note b {{ color:var(--ink) }}
ol,ul {{ padding-left:20px; margin:8px 0 }}
li {{ margin:5px 0 }}
.tooltip {{ position:fixed; pointer-events:none; background:#081009ee; border:1px solid var(--line); border-radius:5px;
  padding:7px 11px; font:12px/1.5 ui-monospace,Menlo,monospace; color:var(--ink); display:none; z-index:9; white-space:nowrap }}
footer {{ margin-top:56px; font-size:12px; color:var(--faint); border-top:1px solid var(--line); padding-top:16px }}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Hyperliquid Copy-Trade Backtest</div>
  <h1>跟单回测：{short}</h1>
  <div class="addr"><a href="https://app.hyperliquid.xyz/explorer/address/{addr}">{addr}</a></div>
  <div class="meta">
    <span>回测窗口 <b>{start_s} → {end_s}</b>（{c['days']:.0f} 天，TWAP 数据完整期）</span>
    <span>初始资金 <b>$100,000</b></span>
    <span>模型 <b>动态等比镜像</b></span>
    <span>费率 <b>taker 4.5bp + 滑点 3bp</b></span>
  </div>
</header>

<section>
  <div class="cards">{cards_html}</div>
</section>

<section>
  <h2>跟单净值曲线 <span class="tag">follower equity · hourly</span></h2>
  <p class="sub">每当该地址有成交（含 TWAP 切片），跟单账户按「自身权益 / 他的权益」等比调整到相同目标仓位；每小时按最新标记价计净值并结算资金费。</p>
  <div class="panel">
    <div class="legend"><span><i style="background:var(--mint)"></i>跟单净值</span><span><i style="background:#3a5c50;height:8px;opacity:.5"></i>回撤深度（下轴）</span></div>
    <canvas id="eqChart" height="380"></canvas>
  </div>
</section>

<section>
  <h2>Leader 全历史（官方口径） <span class="tag">portfolio API · 2024-08 至今</span></h2>
  <p class="sub">该地址 perp 累计已实现+未实现 PnL 与账户权益（含出入金）。近期靠 xyz 股票/商品市场（MU、AMD、SKHX、白银、原油）赚了大部分利润，但 7 月中在 SKHX 上单日回吐约 $265 万。</p>
  <div class="panel">
    <div class="legend"><span><i style="background:var(--mint)"></i>累计 PnL</span><span><i style="background:var(--amber)"></i>账户权益（右轴，受出入金影响）</span></div>
    <canvas id="ldChart" height="340"></canvas>
  </div>
</section>

<section class="cols">
  <div>
    <h2>跟单分市场盈亏 <span class="tag">窗口内</span></h2>
    <div class="panel" style="padding:10px 16px">{rows(coin_rows_copy)}</div>
  </div>
  <div>
    <h2>Leader 已实现盈亏 <span class="tag">全历史 · 前十</span></h2>
    <div class="panel" style="padding:10px 16px">{rows(coin_rows_leader[:10])}</div>
  </div>
</section>

<section>
  <h2>结论怎么看</h2>
  <div class="note" style="border-left-color:var(--mint)">
  一句话：<b>这 56 天跟他，$10 万最终变 $10.37 万（+3.7%），但中途先冲到 $15.4 万、又跌到 $8.7 万——最大回撤 43.8%。</b>
  收益全部来自 6 月的 MU（美光）多单行情，7 月的 SKHX（SK 海力士）重仓多单把利润几乎吐光。
  他的风格是<b>单市场重仓（约 2 倍杠杆押一只票）+ TWAP 分批进出</b>，跟单等于接受同样的集中度风险。56 天样本太短，不构成"能长期赚钱"的证据。
  </div>
</section>

<section>
  <h2>方法与数据口径</h2>
  <ul style="color:var(--mut);font-size:13.5px">
    <li><b style="color:var(--ink)">数据源：</b>Hyperliquid 公开 info API——userFillsByTime（普通成交）+ userTwapSliceFillsByTime（TWAP 切片）+ fundingHistory + candleSnapshot + portfolio。</li>
    <li><b style="color:var(--ink)">为什么从 2026-05-16 开始：</b>该地址大量用 TWAP 下单，而 API 只保留约最近两个月的 TWAP 切片明细。更早的仓位变化无法逐笔还原（只能靠 startPosition 跳变对齐），模拟会失真，所以跟单模拟只跑数据完整段。窗口内重建的期末仓位与链上实际持仓完全一致（xyz:SKHX 10,025.367）。</li>
    <li><b style="color:var(--ink)">残余缺口：</b>窗口内仍有 30 次小的仓位跳变（合计名义约 $98k，占成交名义 5%以下），已按当时价格同步进跟单仓位。</li>
    <li><b style="color:var(--ink)">成交假设：</b>以他的成交 VWAP 为基准，加 3bp 不利滑点 + 4.5bp taker 费。实际跟单还有信号延迟（秒到分钟级），股票类 perp 开盘跳空时刻误差会更大。</li>
    <li><b style="color:var(--ink)">资金费：</b>按各市场逐小时费率对持仓结算，窗口内为净支出 ${abs(fund):,.0f}。</li>
    <li><b style="color:var(--ink)">未包含：</b>他的现货交易（约 1,000 笔，主要是 HYPE 现货）；组合保证金/强平机制未模拟（窗口内粗杠杆峰值约 2.5x，未触及强平线）。</li>
  </ul>
</section>

<footer>数据截至 {end_s} · 回测引擎与本页由 Claude 生成 · 仅供研究，不构成投资建议</footer>
</div>
<div class="tooltip" id="tip"></div>

<script>
const D = {DATA};
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const MINT = "#3fd9a4", RED = "#e0685c", AMBER = "#d9a441", GRID = "#1a2b25", MUT = "#7e968c";
function setup(cv) {{
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = +cv.getAttribute("height");
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
  return [ctx, w, h];
}}
const fmtD = t => new Date(t).toISOString().slice(0, 10);
const fmtM = v => (v < 0 ? "\\u2212$" : "$") + Math.abs(v).toLocaleString("en-US", {{maximumFractionDigits: 0}});

function drawEq() {{
  const cv = document.getElementById("eqChart");
  const [ctx, W, H] = setup(cv);
  const pts = D.curve, PL = 62, PR = 14, PT = 14, PB = 68, DH = 40; // 底部回撤带
  const x0 = pts[0][0], x1 = pts[pts.length-1][0];
  let lo = Infinity, hi = -Infinity, peak = -Infinity;
  const dds = [];
  for (const [t, e] of pts) {{ lo = Math.min(lo, e); hi = Math.max(hi, e); peak = Math.max(peak, e); dds.push((peak - e) / peak); }}
  const pad = (hi - lo) * .07; lo -= pad; hi += pad;
  const X = t => PL + (t - x0) / (x1 - x0) * (W - PL - PR);
  const Y = v => PT + (hi - v) / (hi - lo) * (H - PT - PB - DH - 12);
  const maxdd = Math.max(...dds);
  const YD = d => H - PB + DH - (1 - d / maxdd) * 0; // placeholder
  // 网格 + y轴
  ctx.font = "11px ui-monospace,Menlo,monospace"; ctx.fillStyle = MUT;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {{
    const v = lo + (hi - lo) * i / steps, y = Y(v);
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText("$" + Math.round(v/1000) + "k", PL - 8, y + 4);
  }}
  // x 轴标签
  ctx.textAlign = "center";
  const nlab = Math.min(7, Math.floor(W / 130));
  for (let i = 0; i <= nlab; i++) {{
    const t = x0 + (x1 - x0) * i / nlab;
    ctx.fillText(fmtD(t), X(t), H - PB + DH + 22);
  }}
  // $100k 基准线
  ctx.strokeStyle = "#3a5c50"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(PL, Y(100000)); ctx.lineTo(W - PR, Y(100000)); ctx.stroke(); ctx.setLineDash([]);
  // 面积
  const grad = ctx.createLinearGradient(0, PT, 0, H - PB - 12);
  grad.addColorStop(0, "rgba(63,217,164,.22)"); grad.addColorStop(1, "rgba(63,217,164,0)");
  ctx.beginPath(); ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
  for (const [t, e] of pts) ctx.lineTo(X(t), Y(e));
  ctx.lineTo(X(x1), H - PB - DH + 28); ctx.lineTo(X(x0), H - PB - DH + 28); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // 净值线
  ctx.beginPath(); ctx.strokeStyle = MINT; ctx.lineWidth = 1.8;
  for (let i = 0; i < pts.length; i++) {{ const [t, e] = pts[i]; i ? ctx.lineTo(X(t), Y(e)) : ctx.moveTo(X(t), Y(e)); }}
  ctx.stroke(); ctx.lineWidth = 1;
  // 回撤带 (底部)
  const dTop = H - PB, dBot = H - PB + DH;
  ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, dTop); ctx.lineTo(W - PR, dTop); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(x0), dTop);
  for (let i = 0; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), dTop + dds[i] / maxdd * (DH - 4));
  ctx.lineTo(X(x1), dTop); ctx.closePath();
  ctx.fillStyle = "rgba(224,104,92,.35)"; ctx.fill();
  ctx.fillStyle = MUT; ctx.textAlign = "left";
  ctx.fillText("回撤 0 → \\u2212" + (maxdd * 100).toFixed(0) + "%", PL + 4, dBot + 0);
  // 端点
  const le = pts[pts.length-1];
  ctx.fillStyle = MINT; ctx.beginPath(); ctx.arc(X(le[0]), Y(le[1]), 3.5, 0, 7); ctx.fill();
  ctx.textAlign = "right"; ctx.fillText(fmtM(le[1]), W - PR - 2, Y(le[1]) - 10);
  // hover
  cv.onmousemove = ev => {{
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left;
    let bi = 0, bd = 1e18;
    for (let i = 0; i < pts.length; i += 2) {{ const d = Math.abs(X(pts[i][0]) - mx); if (d < bd) {{ bd = d; bi = i; }} }}
    const tip = document.getElementById("tip");
    tip.style.display = "block";
    tip.style.left = (ev.clientX + 14) + "px"; tip.style.top = (ev.clientY - 10) + "px";
    tip.innerHTML = fmtD(pts[bi][0]) + "<br><b style='color:" + MINT + "'>" + fmtM(pts[bi][1]) + "</b>  dd \\u2212" + (dds[bi]*100).toFixed(1) + "%";
  }};
  cv.onmouseleave = () => document.getElementById("tip").style.display = "none";
}}

function drawLd() {{
  const cv = document.getElementById("ldChart");
  const [ctx, W, H] = setup(cv);
  const pnl = D.lpnl, eq = D.leq, PL = 62, PR = 62, PT = 14, PB = 34;
  const x0 = Math.min(pnl[0][0], eq[0][0]), x1 = Math.max(pnl[pnl.length-1][0], eq[eq.length-1][0]);
  let plo = 0, phi = 0;
  for (const [, v] of pnl) {{ plo = Math.min(plo, v); phi = Math.max(phi, v); }}
  let elo = 0, ehi = 0;
  for (const [, v] of eq) ehi = Math.max(ehi, v);
  phi *= 1.06; plo = plo * 1.2 - (phi) * .02; ehi *= 1.06;
  const X = t => PL + (t - x0) / (x1 - x0) * (W - PL - PR);
  const YP = v => PT + (phi - v) / (phi - plo) * (H - PT - PB);
  const YE = v => PT + (ehi - v) / ehi * (H - PT - PB);
  ctx.font = "11px ui-monospace,Menlo,monospace";
  const steps = 5;
  for (let i = 0; i <= steps; i++) {{
    const v = plo + (phi - plo) * i / steps, y = YP(v);
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.fillStyle = MUT; ctx.textAlign = "right"; ctx.fillText((v<0?"\\u2212":"") + "$" + Math.abs(v/1e6).toFixed(1) + "M", PL - 8, y + 4);
    const ev2 = ehi * i / steps;
    ctx.textAlign = "left"; ctx.fillStyle = "#8a7434"; ctx.fillText("$" + (ev2/1e6).toFixed(0) + "M", W - PR + 8, YE(ev2) + 4);
  }}
  ctx.fillStyle = MUT; ctx.textAlign = "center";
  const nlab = Math.min(8, Math.floor(W / 120));
  for (let i = 0; i <= nlab; i++) {{ const t = x0 + (x1 - x0) * i / nlab; ctx.fillText(fmtD(t).slice(0, 7), X(t), H - PB + 22); }}
  // 0 线
  ctx.strokeStyle = "#3a5c50"; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(PL, YP(0)); ctx.lineTo(W - PR, YP(0)); ctx.stroke(); ctx.setLineDash([]);
  // 权益 (amber, 细)
  ctx.beginPath(); ctx.strokeStyle = "rgba(217,164,65,.75)"; ctx.lineWidth = 1.2;
  for (let i = 0; i < eq.length; i++) {{ const [t, v] = eq[i]; i ? ctx.lineTo(X(t), YE(v)) : ctx.moveTo(X(t), YE(v)); }}
  ctx.stroke();
  // pnl (mint, 粗)
  ctx.beginPath(); ctx.strokeStyle = MINT; ctx.lineWidth = 1.8;
  for (let i = 0; i < pnl.length; i++) {{ const [t, v] = pnl[i]; i ? ctx.lineTo(X(t), YP(v)) : ctx.moveTo(X(t), YP(v)); }}
  ctx.stroke(); ctx.lineWidth = 1;
  const lp = pnl[pnl.length-1];
  ctx.fillStyle = MINT; ctx.beginPath(); ctx.arc(X(lp[0]), YP(lp[1]), 3.5, 0, 7); ctx.fill();
  ctx.textAlign = "right"; ctx.fillText(fmtM(lp[1]), X(lp[0]) - 8, YP(lp[1]) - 8);
  // 跟单窗口阴影
  const cs = {P["copy_start"]};
  ctx.fillStyle = "rgba(63,217,164,.06)";
  ctx.fillRect(X(cs), PT, X(x1) - X(cs), H - PT - PB);
  ctx.fillStyle = "#4a7c6a"; ctx.textAlign = "left";
  ctx.fillText("\\u2190 跟单模拟窗口", X(cs) + 6, PT + 14);
}}
function all() {{ drawEq(); drawLd(); }}
all(); addEventListener("resize", all);
</script>
"""
open("report.html", "w").write(html)
print("report.html written,", len(html), "bytes")
