import json, time, urllib.request, datetime

ADDR = "0xa65ce1d604fa901c13aa29f2126a57d9032e412b"
API = "https://api.hyperliquid.xyz/info"

def post(payload):
    req = urllib.request.Request(API, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

all_fills = []
start = 0
now = int(time.time() * 1000)
while True:
    batch = post({"type": "userFillsByTime", "user": ADDR,
                  "startTime": start, "endTime": now, "aggregateByTime": True})
    if not batch:
        break
    all_fills.extend(batch)
    print(f"batch {len(batch)}: {datetime.datetime.fromtimestamp(batch[0]['time']/1000)} -> {datetime.datetime.fromtimestamp(batch[-1]['time']/1000)}")
    if len(batch) < 2000:
        break
    start = batch[-1]["time"] + 1
    time.sleep(0.3)

seen, fills = set(), []
for f in all_fills:
    key = f.get("tid") or (f["time"], f["coin"], f["px"], f["sz"], f["side"])
    if key not in seen:
        seen.add(key)
        fills.append(f)
fills.sort(key=lambda f: f["time"])
json.dump(fills, open("data/fills.json", "w"))

print(f"\ntotal fills: {len(fills)}")
print("range:", datetime.datetime.fromtimestamp(fills[0]['time']/1000), "->",
      datetime.datetime.fromtimestamp(fills[-1]['time']/1000))
coins = {}
for f in fills:
    c = f["coin"]
    coins.setdefault(c, [0, 0.0])
    coins[c][0] += 1
    coins[c][1] += float(f["px"]) * float(f["sz"])
print("\ncoin / fills / notional($M):")
for c, (n, ntl) in sorted(coins.items(), key=lambda x: -x[1][1]):
    print(f"  {c:12s} {n:5d} {ntl/1e6:10.2f}")
