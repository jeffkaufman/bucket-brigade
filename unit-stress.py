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
  s = []
  n = 1000
  for i in range(n):
    start = time.time()
    fake_request()
    end = time.time()
    s.append(((end-start)*1000))
    print("%s: %s" % (i, s[-1]))
  s.sort()
  print("median: %s" % s[n // 2])
    
  
  
if __name__ == "__main__":
  stress()
