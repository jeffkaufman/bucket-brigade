trap ctrl_c INT

function ctrl_c() {
  echo
  echo shutting down...
  killall uwsgi
  killall python3
  exit
}

python3 shm.py echo0{1,2,3,4,5,6,7,8} &

for i in 01 02 02 03 04 05 06 07 08; do
    uwsgi --http :80$i --wsgi-file \
    server_wrapper.py --threads=1 --processes=1 --disable-logging \
    --declare-option 'segment=$1' --segment=echo$i &
done

echo running...
while true; do read; done
