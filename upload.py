import util
import tempfile
import subprocess
import traceback
import sys
import urllib.parse

def decode_and_save_backing_track(in_data_raw):
  with tempfile.NamedTemporaryFile() as tmp_upload:
    tmp_upload.write(in_data_raw)
    tmp_upload.flush()

    subprocess.check_call([
      "sox",
      "-t", "mp3", tmp_upload.name,
      "-r", "48000",
      "-t", "wav", util.BACKING_TRACK_UPLOAD_FNAME,
      "remix", "1"])

def save_image(in_data_raw):
  with open(util.IMAGE_UPLOAD_FNAME, "wb") as outf:
    outf.write(in_data_raw)
    outf.flush()

def application(environ, start_response):
  try:
    content_length = int(environ.get('CONTENT_LENGTH', 0))
    in_data_raw = environ['wsgi.input'].read(content_length)

    query_string = environ['QUERY_STRING']

    if len(query_string) > 0:
      query_params = urllib.parse.parse_qs(query_string, strict_parsing=True)
    else:
      query_params = {}

    uploadType, = query_params.get("type", [None])
    if uploadType == "backingTrack":
      decode_and_save_backing_track(in_data_raw)
    elif uploadType == "image":
      save_image(in_data_raw)
    else:
      raise Exception("unknown uploadType %s" % uploadType)

    start_response('200 OK', [("Content-Type", "text/plain")])
    return b"ok",
  except Exception as e:
    print("ERROR:", query_string, "\n", traceback.\
          format_exc(), file=sys.stderr)
    return util.die500(start_response, e)

def serve():
  from wsgiref.simple_server import make_server
  make_server(b'',8082,application).serve_forever()

if __name__ == "__main__":
  serve()
