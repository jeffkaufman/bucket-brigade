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
