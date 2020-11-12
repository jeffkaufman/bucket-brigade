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

PACKET_INTERVAL = 0.6 # 600ms


enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(int(server.SAMPLE_RATE * PACKET_INTERVAL)).reshape(
  [-1, server.OPUS_FRAME_SAMPLES])

def send_request(tmp_name, userid):
  ts = int(time.time()) * server.SAMPLE_RATE

  cmd = [
    'curl',
    'https://echo.jefftk.com/api/?read_clock=%s&userid=%s&username=stress' % (
      ts, userid),
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', "@" + tmp_name,
    '--compressed',
    '-sS',
    '-o', '/dev/null']
  subprocess.check_call(cmd)

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
    timings.extend(json.loads(process.stdout.read()))

  print ("[min=%s  max=%s  avg=%s]" % summarize(timings))
    
if __name__ == "__main__":
  run(*sys.argv[1:])
