import sys
import time
import random
import numpy as np
import server

in_data_raw = np.random.default_rng().bytes(150*128)

def fake_request():
  server.handle_post(in_data_raw, query_params = {
    "read_clock": str(int(time.time()) * server.SAMPLE_RATE)
  })

def stress():
  while True:
    start = time.time()
    fake_request()
    end = time.time()

    print("elapsed: %sms" % int((end-start)*1000))
  
if __name__ == "__main__":
  stress()
