# run as: python3 stress.py <n_workers> <n_rounds>

import sys
import subprocess
import opuslib
import numpy as np
import server
import tempfile
import random
from multiprocessing import Pool
import time
import json

PACKET_INTERVAL = 0.6 # 600ms


enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(int(server.SAMPLE_RATE * PACKET_INTERVAL)).reshape(
  [-1, server.OPUS_FRAME_SAMPLES])

def summarize(timing):
  return min(timing), max(timing), sum(timing)//len(timing)

def run(n_workers, n_rounds):
  n_workers = int(n_workers)

  processes = []
  for i in range(n_workers):
    processes.append(subprocess.Popen(["python3", "stress_helper.py",
                                       n_rounds, "stress%s" % i],
                                      stdout=subprocess.PIPE))
  timings = []
  for process in processes:
    process.wait()
    result_text = process.stdout.read()
    try:
      timings.extend(json.loads(result_text))
    except:
      print("Failure:", result_text)

  print ("[min=%s  max=%s  avg=%s]" % summarize(timings))
    
if __name__ == "__main__":
  run(*sys.argv[1:])
