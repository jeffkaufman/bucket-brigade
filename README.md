# Bucket Brigade

Bucket-brigade singing implementation

## Local Development

(These are "orthodox python way" instructions. If you skip the
"virtualenv venv" and the ". venv/bin/activate", you will install the
dependencies in your global Python environment. This is probably
fine.)

```
git clone https://github.com/jeffkaufman/bucket-brigade.git
cd bucket-brigade
virtualenv venv # optional
. venv/bin/activate # optional
pip install -r requirements.txt
```

If you're on a Mac, you will need to install the Opus C library:

```
brew install opus-tools
```

Now, you will need two separate terminals (or screen/tmux sessions
or similar.)

Serve the static files:
```
cd html/
python -mhttp.server
```

Serve the app backend:
```
./server_wrapper.py
```

The static file server will run on http://localhost:8000/ . The app
server will run on http://localhost:8081/ .

If you go to http://localhost:8000/ , hopefully the app should
work. The client ordinarily wants the app server to be running on the
same host as the static file server, at the path "/api/". However, as
a special case, it will automatically notice when it's running on
localhost, and switch to assuming the app server is at
http://localhost:8081/ instead.

When the app is running in the mode. Chrome will be slightly upset
that the static files and the app server have different origins, and
it will send a CORS preflight before every single request. Since the
app makes many requests per second, this can cause weird performance
issues.

The production approach is to use nginx as both a static fileserver,
and a reverse proxy for the app server, on the same port. This
eliminates the CORS issue, but if it's not running on localhost, it
requires using https://, which requires a certificate. (Chrome will
not allow a website served over http to use the microphone.)

There's probably a workable configuration using nginx on
localhost. The app isn't currently set up for that, but it could be.

## Backing Tracks

Backing tracks are 16-bit 1-channel 48k wav files.  You can make one with:

    $ sox input.mp3 -r 48000 output.wav remix 1

This should look like:

    $ soxi output.wav
    Channels       : 1
    Sample Rate    : 48000
    Precision      : 16-bit
    Sample Encoding: 16-bit Signed Integer PCM

## Running an Instance

If you want to run an instance, you need a server.  There are many
companies that offer Virtual Private Servers (VPSes), with different
trade-offs.  This project is almost entirely limited by CPU, for
encoding and decoding audio, which means there's no reason to get an
instance with large amounts of memory.

If you want to support up to about 60 users, any single core server
should be fine.  The public instance is running on Amazon Lightsail,
With their smallest server (512 MB RAM, 1 vCPU, 20 GB SSD,
$3.50/month).

It is possible to support much larger numbers of users, but you'll
need a lot of cores.  If you're interested in doing this, you will
probably also need to customize the UI, since one video call for 100s
of users is not going to work.  See
https://github.com/dspeyer/ritualEngine for an axample of this kind of
customization.

## Configuring a Server

These instructions are verified for a fresh Ubuntu 20.04 LTS install.

### Install Dependencies
```
sudo apt update
sudo apt upgrade
sudo apt install python3-distutils uuid-dev libcap-dev libpcre3-dev \
                 nginx python3-pip emacs letsencrypt opus-tools \
                 python3-certbot-nginx sox libsox-fmt-mp3
sudo python3 -mpip install uwsgi
mkdir ~/src
cd ~/src && git clone https://github.com/jeffkaufman/bucket-brigade.git
sudo usermod -a -G www-data ubuntu
sudo chgrp www-data /home/ubuntu/src/bucket-brigade
chmod g+rwxs /home/ubuntu/src/bucket-brigade
cd ~/src/bucket-brigade && sudo python3 -mpip install -r requirements.txt
mkdir ~/src/bucket-brigade/recordings
# also populate ~/src/bucket-brigade/secrets.json
```

If you get:

```
./src/shared_array_create.c:24:10: fatal error: numpy/arrayobject.h: No such file or directory
 24 | #include <numpy/arrayobject.h>
    |          ^~~~~~~~~~~~~~~~~~~~~
compilation terminated.
```

This means that pip tried to install SharedArray before numpy.  Fix it with:

```
sudo python3 -mpip uninstall SharedArray
sudo python3 -mpip install -r requirements.txt
```

### Twilio Setup

While the singing component does not require any external integration,
the video call component to support the default interface
does. You will need to sign up for a Twilio account, and then fill out
`~/src/bucket-brigade/secrets.json` as:

```
{
  "twilio": {
     "account_sid": "...",
     "api_key": "...",
     "api_secret": "...",
     "room": "You can name your room anything"
  }
}
```

### Theming

You can change the colors as you like, by creating
`~/src/bucket-brigade/local-style.css` with something like:

```
:root {
  --theme-light: rgb(255, 247, 248);
  --theme-medium: rgb(255, 227, 229);
  --theme-dark: rgb(252, 169, 179);
}
```

If there are other changes you would like to make, PRs to make the
styling easier to override are welcome.

### Nginx Config

We mark absolutely everything as uncachable, because at least for now
that's easier than managing it and the savings from proper caching are
tiny.

In /etc/nginx/sites-available/default add:

```
add_header Cache-Control no-cache;
```

### Uploader Configuration

To support people uploading backing tracks, in `/etc/systemd/system/`
create `echo-uploader.service` as:

```
[Unit]
Description=uWSGI echo uploader

[Service]
WorkingDirectory=/home/ubuntu/src/bucket-brigade
ExecStart=/usr/local/bin/uwsgi --socket :7201 --wsgi-file /home/ubuntu/src/bucket-brigade/upload.py --logto /var/log/echo-uploader.log
Restart=always
KillSignal=SIGQUIT
Type=notify
NotifyAccess=all

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable echo-uploader`.

In /etc/nginx/sites-available/default add:

```
location /upload {
   include uwsgi_params;
   uwsgi_pass 127.0.0.1:7201;
   client_max_body_size 16M;
}
```

### Simple Configuration

Handles up to ~60users.

In `/etc/systemd/system/` create `uwsgi-echo-01.service` as:

```
[Unit]
Description=uWSGI echo

[Service]
WorkingDirectory=/home/ubuntu/src/bucket-brigade
ExecStart=/usr/local/bin/uwsgi --socket :7101 --wsgi-file /home/ubuntu/src/bucket-brigade/server_wrapper.py --logto /var/log/uwsgi-echo-01.log
Restart=always
KillSignal=SIGQUIT
Type=notify
NotifyAccess=all

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable uwsgi-echo-01`.

In /etc/nginx/sites-available/default add:

```
location /api {
   include uwsgi_params;
   uwsgi_pass 127.0.0.1:7101;
}
```

### Sharded Configuration

Handles up to ~1000 users, at ~60/core.  The instructions below assume
you are using a 12 core machine: one core for nginx, one core for
bucket brigade, and ten cores for the shards.

In /etc/systemd/system/ create ten files as `uwsgi-echo-01.service`
through `uwsgi-echo-10.service`:

```
[Unit]
Description=uWSGI echo

[Service]
WorkingDirectory=/home/ubuntu/src/bucket-brigade
ExecStart=/usr/local/bin/uwsgi --socket :7101 --wsgi-file /home/ubuntu/src/bucket-brigade/server_wrapper.py --logto /var/log/uwsgi-echo-01.log --declare-option 'segment=$1' --segment=echo01
Restart=always
KillSignal=SIGQUIT
Type=notify
NotifyAccess=all
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

In /etc/systemd/system/ create one file as `echo-shm.service`:

```
[Unit]
Description=Echo Shared Memory Server

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/src/bucket-brigade
ExecStart=/usr/bin/python3 /home/ubuntu/src/bucket-brigade/shm.py echo01 echo02 echo03 echo04 echo05 echo06 echo07 echo08 echo09 echo10
Restart=always
KillSignal=SIGQUIT
NotifyAccess=all
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl enable uwsgi-echo-0{1,2,3,4,5,6,7,8,9} ; sudo systemctl enable uwsgi-echo-10 echo-shm`.

In /etc/nginx/sites-available/default add:

```
location /api/01 {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7101;
}
location /api/02 {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7102;
}
...
location /api/10 {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7110;
}

location /api {
  error_page 418 = @shardone;
  error_page 419 = @shardtwo;
  ...
  error_page 427 = @shardten;

  if ( $arg_userid ~ "^1" ) { return 418; }
  if ( $arg_userid ~ "^2" ) { return 419; }
  ...
  if ( $arg_userid ~ "^0" ) { return 427; }
  return 418;
}

location @shardone {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7101;
}
location @shardtwo {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7102;
}
...
location @shardten {
  include uwsgi_params;
  uwsgi_pass 127.0.0.1:7110;
}
```

## Deploying

Any time you modify your service files you'll need to run:

    sudo systemctl daemon-reload

Anytime you have a new code to run on the server, run either:

```
# Simple
cd ~/src/bucket-brigade && git pull && sudo systemctl restart uwsgi-echo-01

# Sharded
cd ~/src/bucket-brigade && git pull && sudo systemctl restart uwsgi-echo-01 uwsgi-echo-02 uwsgi-echo-03 uwsgi-echo-04 uwsgi-echo-05 uwsgi-echo-06 uwsgi-echo-07 uwsgi-echo-08 uwsgi-echo-09 uwsgi-echo-10 echo-shm
```

## Auto Restart

There is somewhat strange behavior when this has been running for a long time.
I'm currently too lazy to debug this, so I've programmed it to automatically
restart every day at 7AM GMT (2AM or 3AM Eastern):

```
$ sudo crontab -e
0 7 * * * /bin/systemctl restart uwsgi-echo-01
```

### Logs

#### Simple
```
tail -f /var/log/uwsgi-echo-01.log
```

#### Sharded
```
tail -f /var/log/uwsgi-echo-01.log
tail -f /var/log/uwsgi-echo-02.log
...
tail -f /var/log/uwsgi-echo-10.log
journalctl -u echo-shm.service -n 1000
```

## Profiling

The server creates a cProfile profiler by default, but doesn't enable
it. To start profiling, hit the `/start_profile` endpoint; to stop,
hit `/stop_profile`, and to see the results hit `/get_profile`.

These are GET requests so you can do them from a browser easily. I
expect them to be idempotent (i.e. hitting them repeatedly is
harmless), but this still violates good sense by having side effects
in a GET request, so weird things may happen if the browser does
prefetching or something. Be ye warned.

Be careful if using this in production; the profiler has significant
overhead. Don't leave it running.

## Demetronome

The metronome is recorded, but maybe you don't want that.  The demetronome.py
script removes metronome beats.  If you have an example file where it's not
working file a bug and share the file: it could be a lot more sophisticated but
I don't want to get into that until I have an example of a case where it's
needed.
