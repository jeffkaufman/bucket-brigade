import sys
import time
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
      userid, ts),
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', "@" + tmp_name,
    '--compressed',
    '-sS',
    '-o', '/dev/null']
  subprocess.check_call(cmd)

def summarize(timing):
  return min(timing), max(timing), sum(timing)//len(timing)

def stress(args):
  # avoid having everyone at the same offset
  time.sleep(random.random() * PACKET_INTERVAL)



  n_rounds, tmp_name = args

  userid = int(random.random()*10000000)
  timing = []
  full_start = time.time()
  for i in range(n_rounds):
    start = time.time()
    send_request(tmp_name, userid)
    end = time.time()

    duration = end-start
    timing.append(int(duration*1000))

    full_duration = end - full_start
    expected_full_elapsed = i * PACKET_INTERVAL

    if full_duration < expected_full_elapsed:
      time.sleep(expected_full_elapsed - full_duration)

  return timing

def run(n_workers, n_rounds):
  n_workers = int(n_workers)
  n_rounds = int(n_rounds)

  pool = Pool(n_workers)

  with tempfile.NamedTemporaryFile() as tmp:
    data = server.pack_multi([
      np.frombuffer(
        enc.encode_float(packet.tobytes(), server.OPUS_FRAME_SAMPLES),
        np.uint8)
      for packet in zeros]).tobytes()
    tmp.write(data)
    tmp.flush()

    timings = []
    for timing in pool.map(stress, [
        (n_rounds, tmp.name) for i in range(n_workers)]):
      timings.extend(timing)
    print ("[min=%s  max=%s  avg=%s]" % summarize(timings))

if __name__ == "__main__":
  run(*sys.argv[1:])
