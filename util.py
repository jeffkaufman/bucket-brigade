import os
import traceback
import json

AUDIO_DIR = os.path.join(os.path.dirname(__file__), "audio")
BACKING_TRACK_UPLOAD_FNAME = os.path.join(AUDIO_DIR, "User Upload")
IMAGE_UPLOAD_FNAME = os.path.join(
    os.path.dirname(__file__), "html", "user-upload-image")

def die500(start_response, e):
    # This is slightly sketchy: this assumes we are currently in the middle
    #   of an exception handler for the exception e (which happens to be
    #   true.)
    trb = traceback.format_exc().encode("utf-8")
    start_response('500 Internal Server Error', [
        ('Content-Type', 'text/plain'),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Max-Age", "86400"),
        ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
        ("X-Audio-Metadata", json.dumps({
            "kill_client": True,
            "message": str(e)
        }))])
    return trb,

