import sys
import time
import random
import numpy as np
import server
import server_wrapper
import opuslib

PACKET_INTERVAL = 0.6 # 600ms
PACKET_SAMPLES = int(server.SAMPLE_RATE * PACKET_INTERVAL)

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server_wrapper.CHANNELS, opuslib.APPLICATION_AUDIO)
zeros = np.zeros(PACKET_SAMPLES).reshape(
  [-1, server_wrapper.OPUS_FRAME_SAMPLES])

data = server_wrapper.pack_multi([
  np.frombuffer(
    enc.encode_float(packet.tobytes(), server_wrapper.OPUS_FRAME_SAMPLES),
    np.uint8)
  for packet in zeros]).tobytes()

userid = int(random.random()*10000000)
username = "unitstress"

def query_string():
  return "read_clock=%s&userid=%s&username=%s" % (
    (server.calculate_server_clock(),
     userid,
     username))

def fake_outer_request():
  server_wrapper.handle_post(
    userid,
    PACKET_SAMPLES,
    data,
    [],
    query_string())

def fake_inner_request():
  server.handle_post(
    data,
    [],
    query_string())

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

def setup(args):
  global fake_request

  if "inner" in args:
    fake_request = fake_inner_request
  else:
    fake_request = fake_outer_request

if __name__ == "__main__":
  setup(sys.argv[1:])
  stress()
