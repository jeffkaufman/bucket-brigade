import sys
import time
import opuslib
import numpy as np
import server
import server_wrapper
import random
import time
import requests
import json
import wave

PACKET_INTERVAL = 0.6 # 600ms
PACKET_SAMPLES = int(server.SAMPLE_RATE * PACKET_INTERVAL)
OFFSET = 12
READ_WRITE_OFFSET = 2

enc = opuslib.Encoder(
  server.SAMPLE_RATE, server_wrapper.CHANNELS, opuslib.APPLICATION_AUDIO)

def stress(n_rounds, users_per_client, worker_name, url, should_sleep):
  n_rounds = int(n_rounds)
  users_per_client = int(users_per_client)
  should_sleep = {"sleep": True,
                  "nosleep": False}[should_sleep]

  if should_sleep:
    # avoid having everyone at the same offset
    time.sleep(random.random() * PACKET_INTERVAL)

  with wave.open("stress.wav") as inf:
    if inf.getnchannels() != 1:
        raise Exception(
            "wrong number of channels on %s" % state.requested_track)
    if inf.getsampwidth() != 2:
        raise Exception(
            "wrong sample width on %s" % state.requested_track)
    if inf.getframerate() != 48000:
        raise Exception(
            "wrong sample rate on %s" % state.requested_track)

    audio_data = np.frombuffer(
        inf.readframes(-1), np.int16).astype(np.float32) / (2**15)
    audio_data = audio_data[:PACKET_SAMPLES]
    audio_packets = audio_data.reshape([-1, server_wrapper.OPUS_FRAME_SAMPLES])

    data = server_wrapper.pack_multi([
      np.frombuffer(
        enc.encode_float(packet.tobytes(), server_wrapper.OPUS_FRAME_SAMPLES),
        np.uint8)
      for packet in audio_packets]).tobytes()

  s = requests.Session()

  userid = int(random.random()*10000000)
  timing = []
  full_start = int(time.time())
  clock_start = int((time.time() - OFFSET) * server.SAMPLE_RATE)
  for i in range(n_rounds):
    start = time.time()

    ts = clock_start + PACKET_SAMPLES * (i//users_per_client)
    resp = s.post(
      url='%s?read_clock=%s&write_clock=%s&userid=%s%s&username=%s'
        % (url, ts, ts - (READ_WRITE_OFFSET * server.SAMPLE_RATE), userid, i%users_per_client, worker_name),
      data=data,
      headers={
          'Content-Type': 'application/octet-stream',
          'Accept-Encoding': 'gzip',
      })
    if resp.status_code != 200:
      print("got: %s (%s)" % (resp.status_code, resp.content))

    end = time.time()

    duration = end-start
    timing.append(duration*1000)

    full_duration = end - full_start
    expected_full_elapsed = (i//users_per_client) * PACKET_INTERVAL

    if should_sleep:
      if full_duration < expected_full_elapsed:
        time.sleep(expected_full_elapsed - full_duration)

  print(json.dumps(timing))

if __name__ == "__main__":
  stress(*sys.argv[1:])
