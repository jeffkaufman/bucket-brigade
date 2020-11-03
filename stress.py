import sys
import time
import subprocess
import opuslib
import numpy as np
import server
import tempfile
import random

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(28800).reshape([-1, server.OPUS_FRAME_SAMPLES])

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

def stress():
  userid = int(random.random()*10000000)
  
  with tempfile.NamedTemporaryFile() as tmp:
    data = server.pack_multi([
      np.frombuffer(
        enc.encode_float(packet.tobytes(), server.OPUS_FRAME_SAMPLES),
        np.uint8)
      for packet in zeros]).tobytes()
    tmp.write(data)
    tmp.flush()

    while True:
      start = time.time()
      send_request(tmp.name, userid)
      end = time.time()

      print("elapsed: %sms" % int((end-start)*1000))

if __name__ == "__main__":
  stress()
