import os
import sys
import json
import urllib.parse
import numpy as np  # type:ignore
import opuslib  # type:ignore
import traceback

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

# Will be non-null when using shared memory.
shared_memory = None

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

def handle_json_post(in_data, new_events, query_string, print_status):
    in_json = {
        "new_events": new_events,
        "query_string": query_string,
        "print_status": print_status,
    }
    out_json_raw, out_data = shm.ShmClient.handle_post(
        shared_memory, json.dumps(in_json), in_data)

    out_json = json.loads(out_json_raw)

    if "error" in out_json:
        raise Exception(out_json["error"])

    return out_data, out_json["x-audio-metadata"]

def handle_json_clear_events():
    shm.ShmClient.handle_post(
        shared_memory, json.dumps({'clear_events': True}), [])

def handle_post(userid, n_samples, in_data_raw, new_events,
                query_string, print_status=True) -> Tuple[Any, str]:
    try:
        enc, dec = users[userid]
    except KeyError:
        enc = opuslib.Encoder(server.SAMPLE_RATE, CHANNELS,
                              opuslib.APPLICATION_AUDIO)
        dec = opuslib.Decoder(server.SAMPLE_RATE, CHANNELS)
        users[userid] = enc, dec

    in_data = np.frombuffer(in_data_raw, dtype=np.uint8)

    # If the user does not send us any data, we will treat it as silence of length n_samples. This is useful if they are just starting up.
    if len(in_data) == 0:
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

    if shared_memory is not None:
        data, x_audio_metadata = handle_json_post(
            in_data, new_events, query_string, print_status)
    else:
        data, x_audio_metadata = server.handle_post(
            in_data, new_events, query_string, print_status)

    packets = data.reshape([-1, OPUS_FRAME_SAMPLES])
    encoded = []
    for p in packets:
        e = np.frombuffer(enc.encode_float(p.tobytes(), OPUS_FRAME_SAMPLES), np.uint8)
        encoded.append(e)
    data = pack_multi(encoded).tobytes()

    return data, x_audio_metadata

def do_OPTIONS(environ, start_response) -> None:
    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Allow-Headers", "Content-Type, X-Event-Data")])
    return b'',

def do_GET(environ, start_response) -> None:
    global pr

    if environ.get('PATH_INFO', '') == "/start_profile":
        pr.enable()
        start_response('200 OK', [])
        return b'profiling enabled',

    if environ.get('PATH_INFO', '') == "/stop_profile":
        pr.disable()
        start_response('200 OK', [])
        return b'profiling disabled',

    if environ.get('PATH_INFO', '') == "/get_profile":
        s = io.StringIO()
        ps = pstats.Stats(pr, stream=s).sort_stats('tottime')
        ps.print_stats()
        start_response('200 OK', [])
        return s.getvalue().encode("utf-8"),

    server_clock = server.calculate_server_clock()

    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Allow-Headers", "Content-Type, X-Event-Data"),
         ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
         ("X-Audio-Metadata", json.dumps({
             "server_clock": server_clock,
             "server_sample_rate": server.SAMPLE_RATE,
         })),
         ("Content-Type", "application/octet-stream")])
    # If we give a 0-byte response, Chrome Dev Tools gives a misleading error (see https://stackoverflow.com/questions/57477805/why-do-i-get-fetch-failed-loading-when-it-actually-worked)
    return b'ok',

def die500(start_response, e):
    trb = ("%s: %s\n\n%s" % (e.__class__.__name__, e, traceback.format_exc())).encode("utf-8")

    start_response('200 OK', [  # XXX ?
        ('Content-Type', 'text/plain'),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "Content-Type, X-Event-Data"),
        ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
        ("X-Audio-Metadata", json.dumps({
            "kill_client": True,
            "message": str(e)
        }))])
    return trb,

def do_POST(environ, start_response) -> None:
    content_length = int(environ.get('CONTENT_LENGTH', 0))
    in_data_raw = environ['wsgi.input'].read(content_length)

    query_string = environ['QUERY_STRING']
    query_params = urllib.parse.parse_qs(query_string, strict_parsing=True)

    if environ.get('PATH_INFO', '') == "/reset_events":
        if shared_memory is not None:
            handle_json_clear_events()
        else:
            server.clear_events()
        start_response('204 No Content', [])
        return b'',

    try:
        evh = environ["HTTP_X_EVENT_DATA"]
        new_events = json.loads(evh)
    except (KeyError, json.decoder.JSONDecodeError) as e:
        new_events = []
    if type(new_events) != list:
        new_events = []

    userid = None
    try:
        userid, = query_params.get("userid", (None,))
        n_samples, = query_params.get("n_samples", ("0",))
        n_samples = int(n_samples)

        reset_user_state, = query_params.get("reset_user_state", (None,))
        if reset_user_state and userid and (userid in users):
            del users[userid]

        data, x_audio_metadata = handle_post(userid, n_samples, in_data_raw, new_events, query_string)
    except Exception as e:
        # Clear out stale session
        if userid and (userid in users):
            del users[userid]
        return die500(start_response, e)

    start_response(
        '200 OK',
        [("Access-Control-Allow-Origin", "*"),
         ("Access-Control-Allow-Headers", "Content-Type, X-Event-Data"),
         ("Access-Control-Expose-Headers", "X-Audio-Metadata"),
         ("X-Audio-Metadata", x_audio_metadata),
         ("Content-Type", "application/octet-stream")])
    return data,

def application(environ, start_response):
    global shared_memory
    if shared_memory is None and (uwsgi is not None  and 'segment' in uwsgi.opt):
        shm_name = uwsgi.opt['segment']
        if shm_name:
            shared_memory = shm.attach_or_create(shm_name.decode("utf8"))

    return {"GET": do_GET,
            "POST": do_POST,
            "OPTIONS": do_OPTIONS}[environ["REQUEST_METHOD"]](
                environ, start_response)

def serve():
    from wsgiref.simple_server import make_server
    make_server(b'',8081,application).serve_forever()

if __name__ == "__main__":
    serve()
