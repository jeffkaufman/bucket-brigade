import {check} from './lib.js';

const CLOCK_SERVER = Symbol("CLOCK_SERVER");
const CLOCK_CLIENT = Symbol("CLOCK_CLIENT");

export class ClockReference {
    constructor({ sample_rate }) {
        check(this.side !== undefined, "Cannot directly construct abstract base class ClockReference");
        check(sample_rate !== undefined, "Must provide sample_rate as a named argument");
        check(Number.isInteger(sample_rate), "sample_rate must be integer");

        this.sample_rate = sample_rate;
        this.type = this.constructor.name;
    }

    equals(other) {
        return this.side == other.side && this.sample_rate == other.sample_rate;
    }

    static thaw(o) {
        var rv;
        if (o.type == "ServerClockReference") {
            rv = new ServerClockReference({
                sample_rate: o.sample_rate
            });
        } else {
            rv = new ClientClockReference({
                sample_rate: o.sample_rate
            });
        }
        return rv;
    }
}

export class ServerClockReference extends ClockReference {
    get side() { return CLOCK_SERVER; }
}

export class ClientClockReference extends ClockReference {
    get side() { return CLOCK_CLIENT; }
}

export class ClockInterval {
    constructor({ reference, end, length }) {
        check(reference !== undefined, "Must provide reference as a named argument");
        check(Number.isInteger(end), "end must be an integer (measured in samples)", end);
        check(Number.isInteger(length), "length must be an integer (measured in samples)", length);
        check(reference instanceof ClockReference, "reference must be a ClockReference", reference);

        this.end = end;
        this.length = length;
        this.reference = reference;
    }

    get sample_rate() {
        return this.reference.sample_rate;
    }

    get length_seconds() {
        return this.length / this.sample_rate;
    }

    get start() {
        return this.end - this.length;
    }

    static thaw(o) {
        if (o === undefined) {
            return o;
        }
        var rv = new ClockInterval({
            reference: ClockReference.thaw(o.reference),
            end: o.end,
            length: o.length
        });
        return rv;
    }
}

export class AudioChunkBase {
    constructor({ data, interval }) {
        check(data !== undefined && interval !== undefined, "Must provide data and interval as named arguments");
        check(interval instanceof ClockInterval, "interval must be a ClockInterval");

        this.data = data;
        this.interval = interval;
        this.type = this.constructor.name;
    }

    check_clock_reference(clock_reference) {
        if (!clock_reference.equals(this.reference)) {
            throw new Error("Clock references unequal in AudioChunk.check_clock_reference");
        }
    }

    get start() { return this.interval.start; }
    get end() { return this.interval.end; }
    get length() { return this.interval.length; }
    get length_seconds() { return this.interval.length_seconds; }
    get reference() { return this.interval.reference; }
    get sample_rate() { return this.interval.sample_rate; }

    static thaw(o) {
        var rv;
        if (o.type == "AudioChunk") {
            rv = new AudioChunk({
                data: o.data,
                interval: ClockInterval.thaw(o.interval),
            });
        } else {
            rv = new CompressedAudioChunk({
                data: o.data,
                interval: ClockInterval.thaw(o.interval),
            });
        }
        return rv;
    }
}

// This would more correctly be named UncompressedAudioChunk, but the shorter name is nicer.
export class AudioChunk extends AudioChunkBase {
    constructor({ data, interval }) {
        super({ data, interval });

        check(interval.reference instanceof ClientClockReference, "uncompressed audio chunks must be referenced to the client clock");
        check(data instanceof Float32Array, "uncompressed audio data must be a Float32Array");
        check(data.length == interval.length, "interval length must match uncompressed data length");
    }
}

export class CompressedAudioChunk extends AudioChunkBase {
    constructor({ data, interval }) {
        super({ data, interval });

        check(data instanceof Uint8Array, "compressed audio data must be a Uint8Array");
        check(interval.reference instanceof ServerClockReference, "compressed audio chunks must be referenced to the server clock");
    }
}

export class PlaceholderChunk {
    constructor({ reference, length, interval }){
        check(reference !== undefined && length !== undefined, "Must provide reference and length as named arguments");
        check(reference instanceof ClockReference, "reference must be a ClockReference");
        check(Number.isInteger(length), "length must be an integer");
        if (interval !== undefined) {
            check(interval.length == length, "interval must match length");
            check(interval.reference == reference, "interval must match reference");
        }

        this.reference = reference;
        this.length = length;
        this.interval = interval;
        this.data = new Float32Array(length);  // This exists for convenience but is always all zeros
        this.type = this.constructor.name;
    }

    check_clock_reference(clock_reference) {
        if (!clock_reference.equals(this.reference)) {
            throw new Error("Clock references unequal in PlaceholderChunk.check_clock_reference");
        }
    }

    get start() { return this.interval.start; }
    get end() { return this.interval.end; }
    get length_seconds() { return this.interval.length_seconds; }
    get sample_rate() { return this.reference.sample_rate; }

    static thaw(o) {
        var rv = new PlaceholderChunk({
            reference: ClockReference.thaw(o.reference),
            length: o.length,
            interval: ClockInterval.thaw(o.interval),
        });
        return rv;
    }
}

function concat_typed_arrays(arrays, _constructor) {
  if (arrays.length == 0 && _constructor === undefined) {
    throw new Error("cannot concat zero arrays without constructor provided");
  }
  var constructor = _constructor || arrays[0].constructor;
  var total_len = 0;
  arrays.forEach((a) => {
    if (a.constructor !== constructor) {
      throw new Error("must concat arrays of same type");
    }
    total_len += a.length;
  });
  var result = new constructor(total_len);
  var result_idx = 0;
  arrays.forEach((a) => {
    result.set(a, result_idx);
    result_idx += a.length;
  });
  return result;
}

export function concat_chunks(chunks, _reference) {
    check(chunks instanceof Array, "Must provide Array of chunks", chunks);
    check(chunks.length != 0 || _reference !== undefined, "Cannot concat zero chunks without clock reference provided");

    var reference = _reference || chunks[0].reference;
    var arrays = [];

    // PlaceholderChunks have no timing information (and all zeros for samples)
    var placeholder = (chunks[0] instanceof PlaceholderChunk);

    for (var i = 0; i < chunks.length; ++i) {
        check((chunks[i] instanceof PlaceholderChunk) || (chunks[i] instanceof AudioChunk), "can only use concat_chunks on (uncompressed or placeholder) audio chunks", chunks);
        chunks[i].check_clock_reference(reference);
        arrays.push(chunks[i].data);

        if (i != 0 && !placeholder) {
            check(!(chunks[i] instanceof PlaceholderChunk), "Cannot switch from audio chunk back to placeholder chunk");
            check(chunks[i-1].end == chunks[i].start, "Cannot concat non-contiguous chunks");
        }
        placeholder = (chunks[i] instanceof PlaceholderChunk);
    }

    var big_array = concat_typed_arrays(arrays);
    if (placeholder) {
        return new PlaceholderChunk({
            reference,
            length: big_array.length
        });
    } else {
        var interval = new ClockInterval({
            reference,
            end: chunks[chunks.length - 1].end,
            length: big_array.length,
        });
        return new AudioChunk({
            interval,
            data: big_array
        });
    }
}
