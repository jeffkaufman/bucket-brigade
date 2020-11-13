import numpy as np
import SharedArray  # pip install SharedArray
import struct
import sys
import time

MESSAGE_TYPE_POST = 1
MESSAGE_TYPE_CLEAR_EVENTS = 2
MESSAGE_TYPE_RESPONSE = 3
MESSAGE_TYPE_NO_CONTENT = 4

# Buffer layout:
#   1 byte: status
#   2 bytes: json length
#   N bytes: json
#   4 bytes: data length
#   N bytes: data
MAX_JSON_LENGTH = 10000
MAX_DATA_LENGTH = 200000
BUFFER_SIZE = 1 + 2 + MAX_JSON_LENGTH + 2 + MAX_DATA_LENGTH

def clear_events(buf):
    server.clear_events_()

def post(buf):
    index = 1
    
    json_length = struct.unpack("H", buf[index : index+2]),
    index += 2
    
    if json_length > MAX_JSON_LENGTH:
        print("bad json length %s" % json_length)
        return

    in_json_raw = struct.unpack(
        "%ss" % json_length, buf[index : index+json_length]),
    index += json_length

    data_length =  struct.unpack("I", buf[index : index + 4]),
    index += 4

    if data_length > MAX_DATA_LENGTH:
        print("bad data length %s" % data_length)
        return

    in_data = np.frombuffer(buf[index : index + data_length], np.float32)

    out_json_raw, out_data_float = handle_json_post(in_json_raw, in_data)
    out_data = out_data_float.view(dtype=np.unit8)

    index = 1
    
    buf[index : index + 2] = struct.pack("H", len(out_json_raw))
    index += 2

    buf[index : index + len(out_json_raw)] = out_json_raw.encode("utf-8")
    index += len(out_json_raw)

    buf[index : index + 4] =  struct.pack("I", len(out_data))
    index += 4

    buf[index : index + len(out_data)] = out_data

def run(buffers):
    while True:
        didAction = False
        for buf in buffers:
            if buf[0] == MESSAGE_TYPE_POST:
                post(buf)
                buf[0] = MESSAGE_TYPE_RESPONSE
                didAction = True
            elif buf[1] == MESSAGE_TYPE_CLEAR_EVENTS:
                clear_events(buf)
                buf[0] = MESSAGE_TYPE_NO_CONTENT
                didAction = True
        if not didAction:
            time.sleep(1/10000)  # 0.1ms

def start(raw_buffer_names):
    buffer_names = ["shm://" + x for x in raw_buffer_names]
    buffers = []
    for buffer_name in buffer_names:
        buffers.append(SharedArray.create(
            buffer_name, BUFFER_SIZE, dtype=np.uint8))

    try:
        run(buffers)
    finally:
        for buffer_name in buffer_names:
            SharedArray.delete(buffer_name)
    
if __name__ == "__main__":
    start(sys.argv[1:])
