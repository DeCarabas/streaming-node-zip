/*globals BigInt*/
const { Readable, Writable } = require("stream");
const { Zip } = require("../zip");
const { calculateSize } = require("../utils");

// A Writable stream that just counts the number of bytes written to
// it. It has a promise that completes when it is closed, so that you
// can wait after piping them together.
class ByteCountStream extends Writable {
  constructor(options) {
    super(options);
    this.count = BigInt(0);
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  _write(chunk, encoding, callback) {
    this.count += BigInt(chunk.length);
    callback();
  }

  _writev(chunks, callback) {
    this.count += chunks
      .map(c => c.chunk)
      .reduce((s, v) => BigInt(v) + s, BigInt(0));
    callback();
  }

  _destroy(err, callback) {
    if (err && this._reject) {
      this._reject(err);
      this._resolve = this._reject = null;
    }
    callback(err);
  }

  _final(callback) {
    if (this._resolve) {
      this._resolve(this.count);
      this._resolve = this._reject = null;
    }
    callback();
  }
}

// A Readable stream that emits a fixed number of zeros and then stops.
class GarbageStream extends Readable {
  constructor(size, options) {
    super(options);
    this.remaining = size;

    const BUFFER_MAX = 1024 * 1024 * 4;
    this.buffer = Buffer.alloc(size < BUFFER_MAX ? size : BUFFER_MAX, 0);
  }

  _read(size) {
    while (this.remaining > 0) {
      let send = Math.min(this.remaining, this.buffer.length);
      this.remaining -= send;
      if (!this.push(this.buffer.slice(0, send))) {
        return;
      }
    }
    if (this.remaining == 0) {
      this.push(null);
    }
  }
}

module.exports = function({ describe, it, expect }) {
  describe("zip and sizes", () => {
    const checkFile = async (name, size, total, zip64) => {
      const zip = new Zip(total, {zip64});

      // Send in a file of the right size...
      new GarbageStream(Number(size))
        .pipe(zip.startFile(name))
        .on("finish", () => {
          zip.finish();
        });

      const out = new ByteCountStream();
      zip.pipe(out);

      await out.promise;
      expect(out.count).toBe(total);
    };

    describe("small inputs", () => {
      const file = { name: "foo", size: BigInt(1234) };
      const { total, zip64 } = calculateSize([file]);
      const { total: total64, zip64: force64 } = calculateSize([file], true);

      it("doesn't do zip64", () => expect(zip64).toBe(false));

      it("has a size", () => expect(total).toBe(BigInt(1350)));

      it("has a size that matches the zip file", () =>
        checkFile(file.name, file.size, total, zip64));

      it("reports zip64 if forced", () => expect(force64).toBe(true));
      
      it("has a correct zip64 size", () =>
        checkFile(file.name, file.size, total64, true));
    });
    describe("big inputs", () => {
      const file = { name: "foo", size: BigInt("0x700000000") };
      const { total, zip64 } = calculateSize([file]);
      it("does zip64", () => expect(zip64).toBe(true));
      it("has a size", () => expect(total).toBe(BigInt("30064771336")));
    });
  });
};
