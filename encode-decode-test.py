import numpy as np
import opuslib
import math
import wave
import struct
import random

# Whether to use opuslib's "high level" encoder / decoder
hl_enc = False
hl_dec = False

skip_codec = False


fs = 48000
t = 4
f = 440

opus_frame_size = 2880
#opus_frame_size = 960
#opus_frame_size = 120

# generate sine wave
timestamps = np.linspace(0, t, fs*t)
signal = np.sin(f * 2 * np.pi * timestamps)
signal *= 32767
signal = np.int16(signal)

channels = 1

if channels == 2:
    # interleave it
    new_signal = np.zeros(len(signal)*2, dtype=np.int16)
    print(len(signal))
    print(len(new_signal))
    for i in range(len(signal)):
        new_signal[i*2] = signal[i]
        new_signal[i*2+1] = signal[i]
    signal = new_signal

signal_bytes = signal.tobytes()
print(len(signal_bytes))
print(len(signal))


if hl_enc:
    enc = opuslib.Encoder(fs, channels, opuslib.APPLICATION_AUDIO)
else:
    enc = opuslib.api.encoder.create_state(
        48000, channels, opuslib.APPLICATION_AUDIO)

if hl_dec:
    dec = opuslib.Decoder(fs, channels)
else:
    dec = opuslib.api.decoder.create_state(48000, channels)

obj = wave.open('sound.wav','w')
obj.setnchannels(channels)
obj.setsampwidth(2)
obj.setframerate(fs)


for i in range(len(signal_bytes) // (opus_frame_size*channels)):
    packet_bytes_in = signal_bytes[
        i*opus_frame_size*channels :
        (i+1)*opus_frame_size*channels]
    
    if skip_codec:
        decoded = packet_bytes_in
    else:
        if hl_enc:
            encoded = enc.encode(packet_bytes_in, opus_frame_size)
        else:
            encoded = opuslib.api.encoder.encode(
                enc, packet_bytes_in, opus_frame_size, len(packet_bytes_in))
            
        if hl_dec:
            decoded = dec.decode(encoded, opus_frame_size, decode_fec=False)
        else:
            decoded = opuslib.api.decoder.decode(
                dec, encoded, len(encoded), opus_frame_size, False, channels)

        # for some reason, "decoded" here is twice as long as it should be:
        # when channel==1, len(packet_bytes_in) == opus_frame_size.  But
        # len(decoded) == opus_frame_size*2.
            
    obj.writeframesraw(decoded)
    
obj.close()


if not hl_enc:
    opuslib.api.encoder.destroy(enc)
    
if not hl_dec:
    opuslib.api.decoder.destroy(dec)
