import numpy as np
import SharedArray  # pip install SharedArray
import sys
import time
import struct
import server
import json
import traceback

CLIENT_SLEEP_S = 1/10000  #0.1ms
SERVER_SLEEP_S = 1/10000  #0.1ms

MESSAGE_TYPE_POST = 1
MESSAGE_TYPE_RESPONSE = 2

# Buffer layout:
#   1 byte: status
#   2 bytes: json length
#   N bytes: json
#   4 bytes: data length
#   N bytes: data
MAX_JSON_LENGTH = 10000
MAX_DATA_LENGTH = 199998
BUFFER_SIZE = 1 + 2 + MAX_JSON_LENGTH + 4 + MAX_DATA_LENGTH

def attach_or_create(name):
    name = "shm://" + name

    try:
        return SharedArray.attach(name)
    except Exception:
        pass

    return SharedArray.create(name, BUFFER_SIZE, dtype=np.uint8)

def server_turn(buf):
    return buf[0] == MESSAGE_TYPE_POST

def encode_json_and_data(buf, json_raw, data, throw_exceptions):
    data = data.view(dtype=np.uint8)

    index = 1

    json_raw_bytes = json_raw.encode("utf-8")

    errormsg = None
    if len(json_raw_bytes) > MAX_JSON_LENGTH:
        errormsg = "json too long: %s" % len(json_raw_bytes)
    elif len(data) > MAX_DATA_LENGTH:
        errormsg = "data too long: %s" % len(data)

    if errormsg:
        if throw_exceptions:
            raise Exception(errormsg)
        else:
            json_raw_bytes = json.dumps({"error": errormsg}).encode("utf-8")
            data = np.zeros(0, dtype=np.uint8)

    buf[index : index + 2] = memoryview(struct.pack("H", len(json_raw_bytes)))
    index += 2

    buf[index : index + len(json_raw_bytes)] = memoryview(json_raw_bytes)
    index += len(json_raw_bytes)

    buf[index : index + 4] = memoryview(struct.pack("I", len(data)))
    index += 4

    buf[index : index + len(data)] = data

def decode_json_and_data(buf):
    index = 1

    json_length, = buf[index : index + 2].view(dtype=np.uint16)
    index += 2

    if json_length > MAX_JSON_LENGTH:
        raise Exception("bad json length %s" % json_length)

    json_raw = buf[index : index + json_length].tobytes()
    index += json_length

    data_length, = buf[index : index + 4].view(dtype=np.uint32)
    index += 4

    if data_length > MAX_DATA_LENGTH:
        raise Exception("bad data length %s" % data_length)

    data = buf[index : index + data_length].view(np.uint8)

    return json_raw, data

class ShmServer:
    @staticmethod
    def post(buf):
        try:
            in_json_raw, in_data = decode_json_and_data(buf)
            out_json_raw, out_data = server.handle_json_post(in_json_raw, in_data)
            encode_json_and_data(buf, out_json_raw, out_data,
                                 throw_exceptions=False)
        except Exception as e:
            encode_json_and_data(buf, json.dumps(
                {"error": str(e), "inner_bt": traceback.format_exc()}
            ), np.zeros(0, dtype=np.uint8), throw_exceptions=False)

    @staticmethod
    def run(buffer_names):
        buffers = [attach_or_create(buffer_name) for buffer_name in buffer_names]

        while True:
            didAction = False
            for buf in buffers:
                if server_turn(buf):
                    ShmServer.post(buf)
                    buf[0] = MESSAGE_TYPE_RESPONSE
                    didAction = True
            if not didAction:
                time.sleep(SERVER_SLEEP_S)

class ShmClient:
    def __init__(self, shm_name):
        self.buf = attach_or_create(shm_name)

    def handle_post(self, in_json_raw, in_data):
        encode_json_and_data(self.buf, in_json_raw, in_data, throw_exceptions=True)
        self.buf[0] = MESSAGE_TYPE_POST

        self.wait_resp_()

        return decode_json_and_data(self.buf)

    def wait_resp_(self):
        while server_turn(self.buf):
            time.sleep(CLIENT_SLEEP_S)

class FakeClient:
    def handle_post(self, in_json_raw, in_data):
        out_json_raw, out_data = server.handle_json_post(in_json_raw, in_data)
        return out_json_raw.encode("utf-8"), out_data

if __name__ == "__main__":
    ShmServer.run(sys.argv[1:])
