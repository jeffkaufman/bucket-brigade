# solstice-audio-test

Bucket-brigade singing implementation

To run locally for development:

(These are "orthodox python way" instructions. If you skip the "virtualenv venv" and the ". venv/bin/activate", you will install the dependencies in your global Python environment. This is probably fine.)
```
git clone https://github.com/gwillen/solstice-audio-test.git
cd solstice-audio-test
virtualenv venv  # optional
. venv/bin/activate  # optional
pip install -r requirements.txt
```

Now, you will need two separate terminals (or screen/tmux sessions or similar.)

Serve the static files:
```
cd html/
python -mhttp.server
```

Serve the app backend:
```
./server.py
```

The static file server will run on http://localhost:8000/ . The app server will run on http://localhost:8081/ .

If you go to http://localhost:8000/ , hopefully the app should work. The client ordinarily wants the app server to be running on the same host as the static file server, at the path "/api/". However, as a special case, it will automatically notice when it's running on localhost, and switch to assuming the app server is at http://localhost:8081/ instead.

When the app is running in the mode. Chrome will be slightly upset that the static files and the app server have different origins, and it will send a CORS preflight before every single request. Since the app makes many requests per second, this can cause weird performance issues.

The production approach is to use nginx as both a static fileserver, and a reverse proxy for the app server, on the same port. This eliminates the CORS issue, but if it's not running on localhost, it requires using https://, which requires a certificate. (Chrome will not allow a website served over http to use the microphone.)

There's probably a workable configuration using nginx on localhost. The app isn't currently set up for that, but it could be.

## Backing Tracks

Backing tracks are 16-bit 1-channel 48k wav files.  You can make one with:

    $ lame --decode input.mp3 intermediate-a.wav && \
      sox intermediate-a.wav intermediate-b.wav remix 1 && \
      sox intermediate-b.wav -r 48000 output.wav

This should look like:

    $ soxi output.wav
    Channels       : 1
    Sample Rate    : 48000
    Precision      : 16-bit
    Sample Encoding: 16-bit Signed Integer PCM

## uWSGI Server Setup

### Nginx

```
location /api {
   include uwsgi_params;
   uwsgi_pass 127.0.0.1:7095;
}
```

### uWSGI

#### Installing

Dependencies:

```
$ sudo apt install python3.6 python3.6-dev python3-distutils uwsgi uwsgi-src \
                   uuid-dev libcap-dev libpcre3-dev
```

Build the python 3.6 UWSGI plug-in:

```
$ PYTHON=python3.6 uwsgi --build-plugin "/usr/src/uwsgi/plugins/python python36"
```

[Alternate quick install & run (still need to serve the static files separate as above):

`pip3 install uwsgi`  (This automatically builds in the python plugin)
`uwsgi --http :8081 --wsgi-file server.py`  (run the bare python server without nginx)]
OR: `uwsgi --http :8081 --wsgi-file server.py --threads 4`  (now you're living dangerously, this doesn't work yet)

#### Config

Create `/etc/systemd/system/uwsgi-echo.service` with:

```
[Unit]
Description=uWSGI echo

[Service]
ExecStart=/usr/local/bin/uwsgi --plugin python36 --disable-logging --processes=1 --socket :7095 --wsgi-file /root/src/solstice-audio-test/server.py --logto /var/log/uwsgi-echo.log
Restart=always
KillSignal=SIGQUIT
Type=notify
NotifyAccess=all

[Install]
WantedBy=multi-user.target
```

Then run, and re-run any time you edit the `.service` file:

```
$ systemctl daemon-reload
```

#### Updating

Anytime you deploy you need to restart the daemon:

```
$ service uwsgi-echo restart
```

#### Logs

```
$ tail -f /var/log/uwsgi-echo.log
```
