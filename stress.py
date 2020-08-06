import sys
import time
import subprocess

SAMPLE_RATE=11025

def prepare():
  with open("/tmp/stress.empty", "w") as outf:
    for i in range(192000):
      outf.write('\0')

def send_request():
  ts = int(time.time()) * SAMPLE_RATE
  cmd = [
    'curl',
    'https://echo.jefftk.com/api/?read_clock=%s&encoding=b' % ts,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', "@/tmp/stress.empty",
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
  prepare()
  stress()
