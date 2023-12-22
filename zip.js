// This is a very small implementation of streaming zip support, mostly based on
// https://github.com/robbederks/downzip, which was based on the implementation
// specified in: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
//
// It isn't as general as the original: I modified it to basically be node.js
// specific. See README.md for more info.
//
/* global BigInt */
const EventEmitter = require("events");
const { Readable, Writable } = require("stream");
const { Crc32 } = require("./crc32");
const { createByteArray, getTimeStruct, getDateStruct } = require("./utils");

function log(message) {
  console.log(message);
}

class Zip extends Readable {
  constructor(total, options) {
    super(options);

    // Enable large zip compatibility?
    this.total = total;
    this.zip64 = options.zip64;
    if (this.zip64 === undefined && total >= BigInt("0xFFFFFFFF")) {
      this.zip64 = true;
    }

    console.log(`Started zip with zip64: ${this.zip64} and size ${this.total}`);

    // Setup file record
    this.fileRecord = [];
    this.finished = false;

    // Callback for flow control; when push() returns false we fill this out and
    // call it when somebody next calls _read().
    this.callback = null;

    // Setup byte counter
    this.byteCounterBig = BigInt(0);
  }

  // Readable overrides...
  _read(size) {
    // We only (generally) do flow control with the writable stream
    // that we return from startFile, and that we do by tracking the
    // completion callbacks from write().
    if (this.callback != null) {
      const cb = this.callback;
      this.callback = null;
      cb();
    }
  }

  _destroy(err, callback) {
    // This is how we propagate cancellations back up.
    if (this.callback != null) {
      const cb = this.callback;
      this.callback = null;
      cb(err);
    }
    callback(err);
  }

  // Generators
  getZip64ExtraField(fileSizeBig, localFileHeaderOffsetBig) {
    return this.zip64
      ? [
          { data: 0x0001, size: 2 },
          { data: 28, size: 2 },
          { data: fileSizeBig, size: 8 },
          { data: fileSizeBig, size: 8 },
          { data: localFileHeaderOffsetBig, size: 8 },
          { data: 0, size: 4 }
        ]
      : [];
  }

  checkNotFinished() {
    if (this.finished) {
      const err = new Error("Already finished");
      if (!this.destroyed) {
        this.destroy(err);
      }
      throw err;
    }
  }

  checkNotWritingFile() {
    if (this.fileRecord.length > 0) {
      const lastFile = this.fileRecord[this.fileRecord.length - 1];
      if (!lastFile.done) {
        const err = new Error(`The file ${lastFile.name} was not finished.`);
        if (!this.destroyed) {
          this.destroy(err);
        }
        throw err;
      }
    }
  }

  // API
  startFile(fileName) {
    this.checkNotFinished();
    this.checkNotWritingFile();

    log(`Start file: ${fileName}`);
    const date = new Date(Date.now());

    // Add file to record
    const file = {
      name: fileName,
      sizeBig: BigInt(0),
      crc: new Crc32(),
      done: false,
      date,
      headerOffsetBig: this.byteCounterBig
    };
    this.fileRecord.push(file);

    // Generate Local File Header
    const nameBuffer = Buffer.from(fileName, "utf8");
    const header = createByteArray([
      { data: 0x04034b50, size: 4 }, // Signature
      { data: 0x002d, size: 2 }, // Version needed to extract
      { data: 0x0808, size: 2 }, // General purpose bit flag
      { data: 0x0000, size: 2 }, // Compression method
      { data: getTimeStruct(date), size: 2 }, // Time
      { data: getDateStruct(date), size: 2 }, // Date
      { data: 0x00000000, size: 4 }, // crc-32
      { data: this.zip64 ? 0xffffffff : 0x00000000, size: 4 }, // Compressed size
      { data: this.zip64 ? 0xffffffff : 0x00000000, size: 4 }, // Uncompressed size
      { data: nameBuffer.length, size: 2 }, // Name length
      { data: this.zip64 ? 32 : 0, size: 2 }, // Extra field length
      { data: nameBuffer }, // Name
      ...this.getZip64ExtraField(BigInt(0), this.byteCounterBig)
    ]);

    // Write header to output stream and add to byte counter
    this.push(header);
    this.byteCounterBig += BigInt(header.length);

    return new Writable({
      write: (chunk, encoding, callback) => {
        if (this.destroyed) {
          callback(new Error("Already destroyed"));
        }

        try {
          // Write data to output stream, add to CRC and increment the file and global
          // size counters.
          this.byteCounterBig += BigInt(chunk.length);
          file.crc.append(chunk);
          file.sizeBig += BigInt(chunk.length);

          // Defer calling the callback if the internal buffer is full, for flow control
          // purposes.
          if (this.push(chunk)) {
            callback();
          } else {
            this.callback = callback;
          }
        } catch (e) {
          this.destroy(e);
          callback(e);
        }
      },

      final: callback => {
        if (this.destroyed) {
          callback(new Error("Already destroyed"));
        }
        try {
          log(`End file: ${file.name}`);
          const dataDescriptor = createByteArray([
            { data: file.crc.get(), size: 4 }, // Crc32
            { data: file.sizeBig, size: this.zip64 ? 8 : 4 }, // Compressed size
            { data: file.sizeBig, size: this.zip64 ? 8 : 4 } // Uncompressed size
          ]);
          this.push(dataDescriptor);
          this.byteCounterBig += BigInt(dataDescriptor.length);
          file.done = true;
          callback();
        } catch (e) {
          this.destroy(e);
          callback(e);
        }
      }
    });
  }

  finish() {
    this.checkNotFinished();
    this.checkNotWritingFile();
    if (this.destroyed) {
      throw new Error("Already destroyed");
    }

    log(`Finishing zip`);

    // Write central directory headers
    let centralDirectorySizeBig = BigInt(0);
    const centralDirectoryStartBig = this.byteCounterBig;
    this.fileRecord.forEach(file => {
      const { date, crc, sizeBig, name, headerOffsetBig } = file;
      const nameBuffer = Buffer.from(name, "utf8");
      const header = createByteArray([
        { data: 0x02014b50, size: 4 },
        { data: 0x002d, size: 2 },
        { data: 0x002d, size: 2 },
        { data: 0x0808, size: 2 },
        { data: 0x0000, size: 2 },
        { data: getTimeStruct(date), size: 2 },
        { data: getDateStruct(date), size: 2 },
        { data: crc.get(), size: 4 },
        { data: this.zip64 ? 0xffffffff : sizeBig, size: 4 },
        { data: this.zip64 ? 0xffffffff : sizeBig, size: 4 },
        { data: nameBuffer.length, size: 2 },
        { data: this.zip64 ? 32 : 0, size: 2 },
        { data: 0x0000, size: 2 },
        { data: 0x0000, size: 2 },
        { data: 0x0000, size: 2 },
        { data: 0x00000000, size: 4 },
        { data: this.zip64 ? 0xffffffff : headerOffsetBig, size: 4 },
        { data: nameBuffer },
        ...this.getZip64ExtraField(sizeBig, headerOffsetBig)
      ]);
      this.push(header);
      this.byteCounterBig += BigInt(header.length);
      centralDirectorySizeBig += BigInt(header.length);
    });

    if (this.zip64) {
      // Write zip64 end of central directory record
      const zip64EndOfCentralDirectoryRecordStartBig = this.byteCounterBig;
      const zip64EndOfCentralDirectoryRecord = createByteArray([
        { data: 0x06064b50, size: 4 },
        { data: 44, size: 8 },
        { data: 0x002d, size: 2 },
        { data: 0x002d, size: 2 },
        { data: 0, size: 4 },
        { data: 0, size: 4 },
        { data: this.fileRecord.length, size: 8 },
        { data: this.fileRecord.length, size: 8 },
        { data: centralDirectorySizeBig, size: 8 },
        { data: centralDirectoryStartBig, size: 8 }
      ]);
      this.push(zip64EndOfCentralDirectoryRecord);
      this.byteCounterBig += BigInt(zip64EndOfCentralDirectoryRecord.length);

      // Write zip64 end of central directory locator
      const zip64EndOfCentralDirectoryLocator = createByteArray([
        { data: 0x07064b50, size: 4 },
        { data: 0, size: 4 },
        { data: zip64EndOfCentralDirectoryRecordStartBig, size: 8 },
        { data: 1, size: 4 }
      ]);
      this.push(zip64EndOfCentralDirectoryLocator);
      this.byteCounterBig += BigInt(zip64EndOfCentralDirectoryLocator.length);
    }

    const endOfCentralDirectoryRecord = createByteArray([
      { data: 0x06054b50, size: 4 },
      { data: 0, size: 2 },
      { data: 0, size: 2 },
      { data: this.zip64 ? 0xffff : this.fileRecord.length, size: 2 },
      { data: this.zip64 ? 0xffff : this.fileRecord.length, size: 2 },
      { data: this.zip64 ? 0xffffffff : centralDirectorySizeBig, size: 4 },
      { data: this.zip64 ? 0xffffffff : centralDirectoryStartBig, size: 4 },
      { data: 0, size: 2 }
    ]);
    this.push(endOfCentralDirectoryRecord);
    this.push(null);
    this.byteCounterBig += BigInt(endOfCentralDirectoryRecord.length);

    this.finished = true;
    log(
      `Done writing zip file. Wrote ${this.fileRecord.length} files and a total of ${this.byteCounterBig} bytes.`
    );
  }
}

module.exports = { Zip };
