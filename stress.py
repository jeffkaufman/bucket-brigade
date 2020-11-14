# run as: python3 stress.py <n_workers> <n_rounds> <n_shards> <url> <sleep/nosleep>
#
# n_shards=0 for no shards
#
# if n_shards>0, url should have a %s in it to substitute the shard number

import sys
import subprocess
import opuslib
import numpy as np
import tempfile
import random
from multiprocessing import Pool
import time
import json

PACKET_INTERVAL = 0.6 # 600ms

def summarize(timing):
  return min(timing), max(timing), sum(timing)/len(timing)

def run(n_workers, n_rounds, n_shards, url, should_sleep):
  n_workers = int(n_workers)
  n_shards = int(n_shards)

  if n_shards == 0:
    shards = [""]
  else:
    shards = ["%s" % str(i+1).zfill(2) for i in range(n_shards)]

  processes = []
  for i in range(n_workers):
    shard = shards[i%len(shards)]
    if n_shards > 0:
      sharded_url = url % shard
    else:
      sharded_url = url
    processes.append(subprocess.Popen(
      ["python3", "stress_helper.py", n_rounds, "stress%s" % i, sharded_url,
       should_sleep],
      stdout=subprocess.PIPE))
  timings = []
  for process in processes:
    process.wait()
    result_text = process.stdout.read()
    try:
      timings.append(json.loads(result_text))
    except:
      print("Failure:", result_text)

  should_sleep = {"sleep": True,
                  "nosleep": False}[should_sleep]
  if should_sleep:
    all_timings = []
    for timings in timings:
      all_timings.extend(timings)
    print("[min=%.0f  max=%.0f  avg=%.0f]" % summarize(all_timings))
  else:
    for timing in timings:
      print("est %.0f clients" % (
        PACKET_INTERVAL * 1000 * len(timing) / sum(timing)))

if __name__ == "__main__":
  run(*sys.argv[1:])
