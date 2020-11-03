import sys
import time
import subprocess
import opuslib
import numpy as np
import server
import tempfile

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(28800).reshape([-1, server.OPUS_FRAME_SAMPLES])

def send_request():
  data = server.pack_multi([
    np.frombuffer(
      enc.encode_float(packet.tobytes(), server.OPUS_FRAME_SAMPLES),
      np.uint8)
    for packet in zeros]).tobytes()
  ts = int(time.time()) * server.SAMPLE_RATE

  with tempfile.NamedTemporaryFile() as tmp:
    tmp.write(data)
    tmp.flush()
    cmd = [
      'curl',
      'https://echo.jefftk.com/api/?read_clock=%s&userid=1234&username=stress' % ts,
      '-H', 'Content-Type: application/octet-stream',
      '--data-binary', "@" + tmp.name,
      '--compressed',
      '-sS',
      '-o', '/dev/null']
    subprocess.check_call(cmd)

def stress():
  while True:
    start = time.time()
    send_request()
    end = time.time()

    print("elapsed: %sms" % int((end-start)*1000))
  
if __name__ == "__main__":
  stress()
