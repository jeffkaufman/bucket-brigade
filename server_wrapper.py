#!/usr/bin/env python3

import os
import sys
import json
import urllib.parse
import numpy as np  # type:ignore
import opuslib  # type:ignore
import traceback
import time
import struct

try:
    import uwsgi
except Exception:
    # only available in app, not in shell
    uwsgi = None

import SharedArray  # pip install SharedArray

sys.path.append(os.path.dirname(__file__)) # for finding server
import server
import shm

from typing import Any, Dict, List, Tuple

import cProfile
import pstats
import io

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
try:
    os.mkdir(LOG_DIR)
except FileExistsError:
    pass

pr = cProfile.Profile()
# enable for just a moment so the profile object isn't empty
pr.enable()
pr.disable()

CHANNELS = 1

OPUS_FRAME_MS = 60
OPUS_FRAME_SAMPLES = server.SAMPLE_RATE // 1000 * OPUS_FRAME_MS
OPUS_BYTES_PER_SAMPLE = 4  # float32
OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * CHANNELS * OPUS_BYTES_PER_SAMPLE

# TODO: have a system for cleaning up users when we haven't heard for them in
# a long time, so we don't just accumulate encoders indefinitely.
users = {}  # userid -> (enc, dec)

# This will become either a shm.ShmClient or a shm.FakeClient, depending on
#   whether we're in sharded mode or not.
backend = None

def pack_multi(packets) -> Any:
    encoded_length = 1
    for p in packets:
        encoded_length += 2 + len(p)
    outdata = np.zeros(encoded_length, np.uint8)
    outdata[0] = len(packets)
    idx = 1
    for p in packets:
        if p.dtype != np.uint8:
            raise Exception("pack_multi only accepts uint8")
        outdata[idx] = len(p) >> 8
        outdata[idx + 1] = len(p) % 256
        idx += 2
        outdata[idx:idx+len(p)] = p
        idx += len(p)
    return outdata

def unpack_multi(data) -> List[Any]:
    if data.dtype != np.uint8:
        raise Exception("unpack_multi only accepts uint8")
    packet_count = data[0]
    data_idx = 1
    result = []
    for i in range(packet_count):
        length = (data[data_idx] << 8) + data[data_idx + 1]
        data_idx += 2
        packet = data[data_idx:data_idx+length]
        data_idx += length
        result.append(packet)
    return result

def handle_json_post(in_data, query_string, print_status):
    in_json = {
        "query_string": query_string,
        "print_status": print_status,
    }
    out_json_raw, out_data = backend.handle_post(json.dumps(in_json), in_data)

    out_json = json.loads(out_json_raw)

    if "error" in out_json:
        inner_bt = ""
        if "inner_bt" in out_json:
            inner_bt = "\nBackend error details: " + out_json["inner_bt"]
        raise Exception(out_json["error"] + inner_bt)

    return out_data, out_json["x-audio-metadata"]

def calculate_volume(in_data):
    return np.sqrt(np.mean(in_data**2))

def handle_post_special(query_string, print_status=True):
    data, x_audio_metadata = handle_json_post(np.zeros(0), query_string, print_status)
    return data.tobytes(), x_audio_metadata

def handle_post(userid, n_samples, in_data_raw,
                query_string, print_status=True) -> Tuple[Any, str]:
    if not userid.isdigit():
        raise ValueError("UserID must be numeric; got: %r"%userid)
    try:
        enc, dec = users[userid]
    except KeyError:
        enc = opuslib.Encoder(server.SAMPLE_RATE, CHANNELS,
                              opuslib.APPLICATION_AUDIO)
        dec = opuslib.Decoder(server.SAMPLE_RATE, CHANNELS)
        users[userid] = enc, dec

    in_data = np.frombuffer(in_data_raw, dtype=np.uint8)

    # If the user does not send us any data, we will treat it as silence of length n_samples. This is useful if they are just starting up.
    client_no_data = len(in_data)==0
    if client_no_data:
        if n_samples == 0:
            raise ValueError("Must provide either n_samples or data")
        in_data = np.zeros(n_samples, np.float32)
    else:
        packets = unpack_multi(in_data)
        decoded = []
        for p in packets:
            d = dec.decode_float(p.tobytes(), OPUS_FRAME_SAMPLES, decode_fec=False)
            decoded.append(np.frombuffer(d, np.float32))
        in_data = np.concatenate(decoded)

    # Sending n_samples is optional if data is sent, but in case of both they must match
    if n_samples == 0:
        n_samples = len(in_data)
    if n_samples != len(in_data):
        raise ValueError("Client is confused about how many samples it sent (got %s expected %s" % (n_samples, len(in_data)))

    rms_volume = calculate_volume(in_data)
    # This is only safe because query_string is guaranteed to already contain
    #   at least the userid parameter.
    query_string += '&rms_volume=%s'%rms_volume

    data, x_audio_metadata = handle_json_post(
        in_data, query_string, print_status)

    # Divide data into user_summary and raw audio data
    n_users_in_summary, = struct.unpack(">H", data[:2])
    user_summary_n_bytes = server.summary_length(n_users_in_summary)
    
    user_summary = data[:user_summary_n_bytes]
    raw_audio = data[user_summary_n_bytes:].view(np.float32)

    # Encode raw audio
    packets = raw_audio.reshape([-1, OPUS_FRAME_SAMPLES])
    encoded = []
    for p in packets:
        e = np.frombuffer(enc.encode_float(p.tobytes(), OPUS_FRAME_SAMPLES), np.uint8)
        encoded.append(e)
    compressed_audio = pack_multi(encoded)

    # Combine user_summary and compressed audio data
    data = np.append(user_summary, compressed_audio)

    with open(os.path.join(LOG_DIR, userid), "a") as log_file:
        log_file.write("%d %.8f\n"%(
            time.time(),
            -1 if client_no_data else rms_volume))

    return data.tobytes(), x_audio_metadata

def do_OPTIONS(environ, start_response) -> None:
    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Max-Age", "86400")])
    return b'',

# GET requests do not require any specific parameters. Primarily they are used
#   when a client is starting up, to retrieve the server's current time. The
#   use of them to start and stop profiling is kind of gross and should really
#   be a POST, but it's purely for debugging so it's not a big issue.
def do_GET(environ, start_response) -> None:
    global pr

    if environ.get('PATH_INFO', '') == "/api/start_profile":
        pr.enable()
        start_response('200 OK', [])
        return b'profiling enabled',

    if environ.get('PATH_INFO', '') == "/api/stop_profile":
        pr.disable()
        start_response('200 OK', [])
        return b'profiling disabled',

    if environ.get('PATH_INFO', '') == "/api/get_profile":
        s = io.StringIO()
        ps = pstats.Stats(pr, stream=s).sort_stats('tottime')
        ps.print_stats()
        start_response('200 OK', [])
        return s.getvalue().encode("utf-8"),

    server_clock = server.calculate_server_clock()

    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Max-Age", "86400"),
         ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
         ("X-Audio-Metadata", json.dumps({
             "server_clock": server_clock,
             "server_sample_rate": server.SAMPLE_RATE,
         })),
         ("Content-Type", "application/octet-stream")])
    # If we give a 0-byte response, Chrome Dev Tools gives a misleading error (see https://stackoverflow.com/questions/57477805/why-do-i-get-fetch-failed-loading-when-it-actually-worked)
    return b'ok',

def die500(start_response, e):
    if isinstance(e, Exception):
        # This is slightly sketchy: this assumes we are currently in the middle
        #   of an exception handler for the exception e (which happens to be
        #   true.)
        trb = traceback.format_exc().encode("utf-8")
    else:
        trb = str(e).encode("utf-8")

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

# POST requests absolutely must have a numeric user_id for all requests which
#   make it as far as handle_post; such requests must be associated with a user
#   or there's nothing we can do with them, and they will fail.
# There are a few exceptions for "special" requests not associated with a
#   specific user, which are handled right here.
def do_POST(environ, start_response) -> None:
    content_length = int(environ.get('CONTENT_LENGTH', 0))
    in_data_raw = environ['wsgi.input'].read(content_length)

    query_string = environ['QUERY_STRING']

    # For some reason parse_qs can't handle an empty query string
    if len(query_string) > 0:
        query_params = urllib.parse.parse_qs(query_string, strict_parsing=True)
    else:
        query_params = {}

    userid = None
    try:
        userid, = query_params.get("userid", (None,))

        n_samples, = query_params.get("n_samples", ("0",))
        n_samples = int(n_samples)

        if (userid is None) and (len(in_data_raw) > 0 or n_samples != 0):
            return die500("Can't send non-user request with audio data.")

        reset_user_state, = query_params.get("reset_user_state", (None,))
        if reset_user_state and userid and (userid in users):
            del users[userid]

        if userid is not None:
            data, x_audio_metadata = handle_post(userid, n_samples, in_data_raw, query_string)
        else:
            data, x_audio_metadata = handle_post_special(query_string)
    except Exception as e:
        # Clear out stale session
        if userid and (userid in users):
            del users[userid]
        # Log it
        print("Request raised exception!\nParams:", query_string, "\n", traceback.format_exc(), file=sys.stderr)
        return die500(start_response, e)

    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Max-Age", "86400"),
         ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
         ("X-Audio-Metadata", x_audio_metadata),
         ("Content-Type", "application/octet-stream")])
    return data,

def application(environ, start_response):
    global backend

    if backend is None:
        if uwsgi is not None  and 'segment' in uwsgi.opt:
            shm_name = uwsgi.opt['segment']
            if shm_name:
                backend = shm.ShmClient(shm_name.decode("utf-8"))

    # If that didn't work, we're not sharded.
    if backend is None:
        backend = shm.FakeClient()

    return {"GET": do_GET,
            "POST": do_POST,
            "OPTIONS": do_OPTIONS}[environ["REQUEST_METHOD"]](
                environ, start_response)

def serve():
    from wsgiref.simple_server import make_server
    make_server(b'',8081,application).serve_forever()

if __name__ == "__main__":
    serve()
