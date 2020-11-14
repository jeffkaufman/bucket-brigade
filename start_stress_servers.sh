#!/bin/bash
# usage: ./start_stress_servers.sh {1..8}

trap ctrl_c INT

function ctrl_c() {
  echo
  echo shutting down...
  killall uwsgi
  killall python3
  exit
}

SEGMENTS=""
for i in $@; do
  SEGMENTS+=" stress0$i"
done

python3 shm.py $SEGMENTS &

for i in $@; do
  uwsgi --http :810$i --wsgi-file \
       server_wrapper.py --threads=1 --processes=1 --disable-logging \
       --declare-option 'segment=$1' --segment=stress0$i &
done

echo running...
while true; do read; done
