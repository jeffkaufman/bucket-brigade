import numpy as np
import SharedArray  # pip install SharedArray
import sys
import time
import struct
import server

CLIENT_SLEEP_S = 1/10000  #0.1ms
SERVER_SLEEP_S = 1/10000  #0.1ms

MESSAGE_TYPE_POST = 1
MESSAGE_TYPE_CLEAR_EVENTS = 2
MESSAGE_TYPE_RESPONSE = 3

# Buffer layout:
#   1 byte: status
#   2 bytes: json length
#   N bytes: json
#   4 bytes: data length
#   N bytes: data
MAX_JSON_LENGTH = 10000
MAX_DATA_LENGTH = 200000
BUFFER_SIZE = 1 + 2 + MAX_JSON_LENGTH + 2 + MAX_DATA_LENGTH

def attach_or_create(name):
    name = "shm://" + name

    try:
        return SharedArray.attach(name)
    except Exception:
        pass

    return SharedArray.create(name, BUFFER_SIZE, dtype=np.uint8)

def server_turn(buf):
    return buf[0] in [MESSAGE_TYPE_POST, MESSAGE_TYPE_CLEAR_EVENTS]

def encode_json_and_data(buf, json_raw, data):
    index = 1

    buf[index : index + 2] = memoryview(struct.pack("H", len(json_raw)))
    index += 2

    json_raw_bytes = json_raw.encode("utf-8")
    buf[index : index + len(json_raw_bytes)] = memoryview(json_raw_bytes)
    index += len(json_raw_bytes)

    data_uint8 = data.view(dtype=np.uint8)
    buf[index : index + 4] = memoryview(struct.pack("I", len(data_uint8)))
    index += 4

    buf[index : index + len(data_uint8)] = data_uint8

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
        raise Exeption("bad data length %s" % data_length)

    data = buf[index : index + data_length].view(np.float32)

    return json_raw, data

class ShmServer:
    @staticmethod
    def clear_events():
        server.clear_events_()

    @staticmethod
    def post(buf):
        in_json_raw, in_data = decode_json_and_data(buf)
        out_json_raw, out_data = server.handle_json_post(in_json_raw, in_data)
        encode_json_and_data(buf, out_json_raw, out_data)

    @staticmethod
    def run(buffer_names):
        buffers = [attach_or_create(buffer_name) for buffer_name in buffer_names]

        while True:
            didAction = False
            for buf in buffers:
                if server_turn(buf):
                    if buf[0] == MESSAGE_TYPE_POST:
                        ShmServer.post(buf)
                    elif buf[1] == MESSAGE_TYPE_CLEAR_EVENTS:
                        ShmServer.clear_events()
                    buf[0] = MESSAGE_TYPE_RESPONSE
                    didAction = True
            if not didAction:
                time.sleep(SERVER_SLEEP_S)

class ShmClient:
    @staticmethod
    def clear_events(buf):
        buf[0] = MESSAGE_TYPE_CLEAR_EVENTS
        ShmClient.wait_resp_(buf)

    @staticmethod
    def handle_post(buf, in_json_raw, in_data):
        encode_json_and_data(buf, in_json_raw, in_data)
        buf[0] = MESSAGE_TYPE_POST

        ShmClient.wait_resp_(buf)

        return decode_json_and_data(buf)

    @staticmethod
    def wait_resp_(buf):
        while server_turn(buf):
            time.sleep(CLIENT_SLEEP_S)


if __name__ == "__main__":
    ShmServer.run(sys.argv[1:])
