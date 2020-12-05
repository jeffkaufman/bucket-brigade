# run as: python3 stress.py <n_workers> <users_per_client> <n_rounds> <url> <sleep/nosleep>

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

def run(n_workers, users_per_client, n_rounds, url, should_sleep):
  n_workers = int(n_workers)

  processes = []
  for i in range(n_workers):
    processes.append(subprocess.Popen(
      ["python3", "stress_helper.py", n_rounds, users_per_client,
       "stress%s" % i, url, should_sleep],
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
    total = 0
    for timing in timings:
      est = PACKET_INTERVAL * 1000 * len(timing) / sum(timing)
      print("est %.0f clients" % est)
      total += est
    print("total: %.0f clients" % total)

if __name__ == "__main__":
  run(*sys.argv[1:])
