import sys
import time
import random
import numpy as np
import server
import opuslib

PACKET_INTERVAL = 0.6 # 600ms
PACKET_SAMPLES = int(server.SAMPLE_RATE * PACKET_INTERVAL)

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(PACKET_SAMPLES).reshape(
  [-1, server.OPUS_FRAME_SAMPLES])

data = server.pack_multi([
  np.frombuffer(
    enc.encode_float(packet.tobytes(), server.OPUS_FRAME_SAMPLES),
    np.uint8)
  for packet in zeros]).tobytes()

userid = int(random.random()*10000000)
username = "unitstress"

def fake_request():
  server.handle_post(data, query_params = {
    "read_clock": (str(int(time.time()) * server.SAMPLE_RATE),),
    "userid": (userid,),
    "username": (username,),
  }, environ=None)

def stress():
  for i in range(3):
    start = time.time()
    n_requests = 1000
    for i in range(n_requests):
      fake_request()
    end = time.time()

    each_s = (end-start)/n_requests

    print("%.2fms each; est %.0f clients" % (
      each_s*1000,
      PACKET_INTERVAL/each_s))

class FakeEncoder:
  def __init__(*args):
    pass

  def encode_float(self, _, n_samples):
    return np.zeros(n_samples)

class FakeDecoder:
  def __init__(*args):
    pass

  def decode_float(self, _, n_samples, **kwargs):
    return np.zeros(n_samples)

def setup(args):
  if args and args[0] == "noopus":
    opuslib.Encoder = FakeEncoder
    opuslib.Decoder = FakeDecoder

if __name__ == "__main__":
  setup(sys.argv[1:])
  stress()
