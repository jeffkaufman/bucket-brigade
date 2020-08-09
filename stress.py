import sys
import time
import subprocess
import threading
from urllib.parse import urlparse
import http.client, sys
import signal
import traceback
from collections import defaultdict
import random

SAMPLE_RATE=11025
SAMPLES=19200
WINDOW = SAMPLES / SAMPLE_RATE

data = b'0' * SAMPLES
die = False

CONCURRENCY = 200
stats = [defaultdict(int) for _ in range(CONCURRENCY)]
for i in range(len(stats)):
  stats[i]["id"] = i

def stress(id=None):
  global die

  randwait = random.uniform(0, WINDOW)
  time.sleep(randwait)
  print("**Thread", id, "started after sleeping", randwait, "**")
  while True:
    if die:
      return

    start = time.time()

    ts = int(start * SAMPLE_RATE)
    encoding = 'f'
    urlstring = f'http://localhost:8081/?read_clock={ts}&encoding={encoding}'
    url = urlparse(urlstring)
    try:
      stats[id]["requests"] += 1
      #print("  - Thread", id, "making request")
      #r = requests.post(url, data=data)
      conn = http.client.HTTPConnection(url.netloc)
      conn.request("POST", urlstring, data)
      r = conn.getresponse()
      l = len(r.read())
      conn.close()
      #print("  - Thread", id, "response len:", l)
    except KeyboardInterrupt:
      print("KeyboardInterrupt thread")
      die = True
      raise
    except Exception as e:
      print("**Thread", id, "- request failed**:", e)
      stats[id]["failures"] += 1
      #print(traceback.format_exc())
      continue

    end = time.time()
    elapsed = end - start
    #print("Thread", id, "- elapsed: %sms, sleeping %sms" % (int(elapsed * 1000), int((WINDOW - elapsed)*1000)))
    stats[id]["responses"] += 1
    stats[id]["total_ms"] += elapsed * 1000
    if WINDOW - elapsed > 0:
      time.sleep(WINDOW - elapsed)
    else:
      print("Thread", id, "overran timeslot, giving up")
      stats[id]["crashed"] = 1
      return

def signal_handler(signal, frame):
  global die
  die = True
  print("exiting...")

if __name__ == "__main__":
  print(f'time window is {WINDOW} seconds')
  signal.signal(signal.SIGINT, signal_handler)
  threads = [threading.Thread(target=stress, kwargs={"id": i}, daemon=True) for i in range(CONCURRENCY)]
  [t.start() for t in threads]
  for t in threads:
    t.join()
  stats.sort(key=lambda x: x["responses"])
  for s in stats:
    if s["crashed"]:
      continue
    avg = (s["total_ms"] / s["responses"]) if s["responses"] else None
    print(f'Thread {s["id"]}: {s["requests"]:3} requests, {s["responses"]:3} responses, {s["failures"]:3} failures, crashed={s["crashed"]}. avg_ms: {avg}')
  print("\nTotal threads:", CONCURRENCY, "; crashed threads:", sum([s["crashed"] for s in stats]))
  print("Total failures:", sum([s["failures"] for s in stats]))
  print("...exited")
