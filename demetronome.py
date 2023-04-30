#!/usr/bin/env python3

import sys
import wave

# Remove the metronome from a recording.
#
# This could be a lot smarter: the beats are a consistent number of samples
# apart, for example, and we could detect them by looking for samples that are
# way apart from their neighbors instead of just ones that are very high.  But
# this works on the sample, so no need to do any more for now.

input_fname, output_fname, threshold = sys.argv[1:]
threshold = int(threshold)  # try 13000 or so

input_wave = wave.open(input_fname, mode='rb')
output_wave = wave.open(output_fname, mode='wb')

CHANNELS=1
WIDTH=2

assert input_wave.getnchannels() == CHANNELS
assert input_wave.getsampwidth() == WIDTH
output_wave.setnchannels(input_wave.getnchannels())
output_wave.setsampwidth(input_wave.getsampwidth())
output_wave.setframerate(input_wave.getframerate())

l = 0
samples = []
while f := input_wave.readframes(1024):
    l += len(f)
    prev = None
    for i, s in enumerate(f):
        if i % 2 == 0:
            prev = s
        else:
            sample = int.from_bytes([prev, s],
                                    byteorder="little",
                                    signed=True)
            samples.append(sample)

metronome_values = []
for sample in samples:
    if sample > threshold:
        metronome_values.append(sample)
metronome_average = round(sum(metronome_values) / len(metronome_values))

new_samples = []
for sample in samples:
    if sample > threshold:
        sample -= metronome_average
    new_samples.append(sample)

new_frames = []
for sample in new_samples:
    new_frames.extend(sample.to_bytes(byteorder="little",
                                      signed=True,
                                      length=WIDTH))

output_wave.writeframes(bytes(new_frames))        
