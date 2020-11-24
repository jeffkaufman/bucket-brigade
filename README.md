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
If you're on a Mac, you will need to install the Opus C library:
```
brew install opus-tools 
```
Now, you will need two separate terminals (or screen/tmux sessions or similar.)

Serve the static files:
```
cd html/
python -mhttp.server
```

Serve the app backend:
```
./server_wrapper.py
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
`uwsgi --http :8081 --wsgi-file server_wrapper.py`  (run the bare python server without nginx)]
OR: `uwsgi --http :8081 --wsgi-file server_wrapper.py --threads 4` (alpha)

#### Config

Create `/etc/systemd/system/uwsgi-echo.service` with:

```
[Unit]
Description=uWSGI echo

[Service]
ExecStart=/usr/local/bin/uwsgi --plugin python36 --disable-logging --processes=1 --socket :7095 --wsgi-file /root/src/solstice-audio-test/server_wrapper.py --logto /var/log/uwsgi-echo.log
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

### Shared Memory Operation

#### uWSGI

Set up multiple services (`/etc/systemd/system/uwsgi-echo-01.service`,
`echo-02`, ...) each with a unique socket (`socket :7101`, `socket
:7102`, ...), log (`--logto /var/log/uwsgi-echo-01.log`,
`uwsgi-echo-02.log`), and segment (`--declare-option 'segment=$1'
--segment=echo01`, `echo02`, ...).

#### Nginx

Configure nginx to shard requests to these uwsgi sockets by userid.
This is probably going to require moving the user ID into the pass so
nginx can match on it.

#### ShmServer

Create `/etc/systemd/system/echo-shm.service` with:

```
[Unit]
Description=Echo Shared Memory Server

[Service]
ExecStart=/usr/bin/python3 /root/src/solstice-audio-test/shm.py echo01 echo02 (etc...)
Restart=always
KillSignal=SIGQUIT
Type=simple
NotifyAccess=all

[Install]
WantedBy=multi-user.target
```

## Profiling

The server creates a cProfile profiler by default, but doesn't enable it. To start profiling, hit the `/start_profile` endpoint; to stop, hit `/stop_profile`, and to see the results hit `/get_profile`.

These are GET requests so you can do them from a browser easily. I expect them to be idempotent (i.e. hitting them repeatedly is harmless), but this still violates good sense by having side effects in a GET request, so weird things may happen if the browser does prefetching or something. Be ye warned.

Be careful if using this in production; the profiler has significant overhead. Don't leave it running.
