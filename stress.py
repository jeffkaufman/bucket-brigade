# run as: python3 stress.py <n_workers> <n_rounds>

import sys
import subprocess
import json

def summarize(timing):
  return min(timing), max(timing), sum(timing)//len(timing)

def run(n_workers, n_rounds):
  n_workers = int(n_workers)

  processes = []
  for i in range(n_workers):
    processes.append(subprocess.Popen(["python3", "stress_helper.py",
                                       n_rounds, "stress%s" % i],
                                      stdout=subprocess.PIPE))
  timings = []
  for process in processes:
    process.wait()
    timings.extend(json.loads(process.stdout.read()))

  print ("[min=%s  max=%s  avg=%s]" % summarize(timings))
    
if __name__ == "__main__":
  run(*sys.argv[1:])
