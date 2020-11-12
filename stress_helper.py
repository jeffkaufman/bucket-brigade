import sys
import time
import opuslib
import numpy as np
import server
import random
import time
import requests
import json

PACKET_INTERVAL = 0.6 # 600ms
PACKET_SAMPLES = int(server.SAMPLE_RATE * PACKET_INTERVAL)

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(PACKET_SAMPLES).reshape(
  [-1, server.OPUS_FRAME_SAMPLES])

def stress(n_rounds, worker_name):
  n_rounds = int(n_rounds)    
  
  # avoid having everyone at the same offset
  time.sleep(random.random() * PACKET_INTERVAL)

  data = server.pack_multi([
    np.frombuffer(
      enc.encode_float(packet.tobytes(), server.OPUS_FRAME_SAMPLES),
      np.uint8)
    for packet in zeros]).tobytes()

  s = requests.Session()

  userid = int(random.random()*10000000)
  timing = []
  full_start = int(time.time())
  for i in range(n_rounds):
    start = time.time()

    ts = full_start + PACKET_SAMPLES * i
    resp = s.post(
      url='https://echo.jefftk.com/api/?read_clock=%s&userid=%s&username=%s'
        % (ts, userid, worker_name),
      data=data,
      headers={
          'Content-Type': 'application/octet-stream',
          'Accept-Encoding': 'gzip',
      })
    if resp.status_code != 200:
      print("got: %s" % resp.status_code)

    end = time.time()

    duration = end-start
    timing.append(int(duration*1000))

    full_duration = end - full_start
    expected_full_elapsed = i * PACKET_INTERVAL

    if full_duration < expected_full_elapsed:
      time.sleep(expected_full_elapsed - full_duration)

  print(json.dumps(timing))
    
if __name__ == "__main__":
  stress(*sys.argv[1:])
