import json, time, urllib.request, datetime
from collections import defaultdict

API = "https://api.hyperliquid.xyz/info"
def post(payload, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(API, data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=30).read())
        except Exception as e:
            if i == retries-1: raise
            time.sleep(1+i)

fills = json.load(open("data/fills_raw.json"))
twaps = [t["fill"] for t in json.load(open("data/twap_fills.json"))]
allf = fills + twaps
perp = [f for f in allf if not f["coin"].startswith("@") and "/" not in f["coin"]]
perp.sort(key=lambda f: f["time"])

# 每个 coin 的数据窗口: 首笔前1天 ~ 现在(有未平仓)或末笔后2天
now = int(time.time()*1000)
windows = {}
by_coin = defaultdict(list)
for f in perp: by_coin[f["coin"]].append(f)
OPEN_NOW = {"xyz:SKHX"}
for c, fs in by_coin.items():
    t0 = fs[0]["time"] - 86400_000
    t1 = now if c in OPEN_NOW else min(now, fs[-1]["time"] + 2*86400_000)
    windows[c] = (t0, t1)
    print(c, datetime.datetime.fromtimestamp(t0/1000).date(), "->", datetime.datetime.fromtimestamp(t1/1000).date())

# 1h K线
candles = {}
for c, (t0, t1) in windows.items():
    rows, start = [], t0
    while start < t1:
        batch = post({"type":"candleSnapshot","req":{"coin":c,"interval":"1h","startTime":start,"endTime":t1}})
        if not batch: break
        rows.extend(batch)
        last = batch[-1]["t"]
        if len(batch) < 4900 or last <= start: break
        start = last + 1
        time.sleep(0.2)
    dedup = {r["t"]: r for r in rows}
    candles[c] = [[t, float(dedup[t]["c"])] for t in sorted(dedup)]
    print(f"candles {c}: {len(candles[c])}")
    time.sleep(0.2)
json.dump(candles, open("data/candles.json","w"))

# 资金费率
funding = {}
for c, (t0, t1) in windows.items():
    rows, start = [], t0
    while start < t1:
        try:
            batch = post({"type":"fundingHistory","coin":c,"startTime":start,"endTime":t1})
        except Exception as e:
            print(f"funding {c} ERR {e}"); batch = []
        if not isinstance(batch, list) or not batch: break
        rows.extend(batch)
        last = batch[-1]["time"]
        if last <= start: break
        start = last + 1
        time.sleep(0.2)
        if len(batch) < 400: break
    funding[c] = [[r["time"], float(r["fundingRate"])] for r in rows]
    print(f"funding {c}: {len(funding[c])}")
json.dump(funding, open("data/funding.json","w"))
print("done")
