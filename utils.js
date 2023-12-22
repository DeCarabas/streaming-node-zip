// Adapted from https://github.com/robbederks/downzip/blob/master/src/zip/ZipUtils.js
/* global BigInt */

// Data is an array in the format: [{data: 0x0000, size: 2} or {data: Buffer()}, ...]
function createByteArray(data) {
  const size = data.reduce((acc, value) => {
    return acc + (value.size ? value.size : value.data.length);
  }, 0);

  const buffer = Buffer.alloc(size);

  let i = 0;
  data.forEach(entry => {
    if (entry.data.copy !== undefined && entry.data.length !== undefined) {
      // Entry data is a buffer.
      entry.data.copy(buffer, i);
      i += entry.data.length;
    } else {
      // Entry data is some kind of integer
      switch (entry.size) {
        case 0: // Special case.
          break;
        case 1:
          buffer.writeUInt8(parseInt(entry.data), i);
          break;
        case 2:
          buffer.writeUInt16LE(parseInt(entry.data), i);
          break;
        case 4:
          buffer.writeUInt32LE(parseInt(entry.data), i);
          break;
        case 8:
          buffer.writeBigUInt64LE(BigInt(entry.data), i);
          break;
        default:
          const error = `createByteArray: No handler defined for data size ${
            entry.size
          } of entry data ${JSON.stringify(entry.data)}`;
          throw new Error(error);
      }
      i += entry.size;
    }
  });
  return buffer;
}

// Files is {name:string, size:number}[]
function calculateSize(files, zip64) {
  const localHeaderSizeBig = file => BigInt(30 + file.name.length);
  const dataDescriptorSizeBig = BigInt(12);
  const centralDirectoryHeaderSizeBig = file => BigInt(46 + file.name.length);
  const endOfCentralDirectorySizeBig = BigInt(22);
  const zip64ExtraFieldSizeBig = BigInt(32);
  const zip64DataDescriptorSizeBig = BigInt(20);
  const zip64EndOfCentralDirectoryRecordSizeBig = BigInt(56);
  const zip64EndOfCentralDirectoryLocatorSizeBig = BigInt(20);

  let totalSizeBig = files.reduce((acc, val) => {
    return (
      acc +
      localHeaderSizeBig(val) +
      BigInt(val.size) +
      dataDescriptorSizeBig +
      centralDirectoryHeaderSizeBig(val)
    );
  }, BigInt(0));
  totalSizeBig += endOfCentralDirectorySizeBig;

  zip64 = !!zip64;
  if (totalSizeBig >= BigInt("0xFFFFFFFF") || zip64) {
    // We have a ZIP64! Add all the data we missed before
    totalSizeBig = files.reduce((acc, val) => {
      return (
        acc +
        zip64ExtraFieldSizeBig +
        (zip64DataDescriptorSizeBig - dataDescriptorSizeBig) +
        zip64ExtraFieldSizeBig
      );
    }, totalSizeBig);
    totalSizeBig += zip64EndOfCentralDirectoryRecordSizeBig;
    totalSizeBig += zip64EndOfCentralDirectoryLocatorSizeBig;
    zip64 = true;
  }

  return { total: totalSizeBig, zip64 };
}

function getTimeStruct(date) {
  return (
    (((date.getHours() << 6) | date.getMinutes()) << 5) |
    (date.getSeconds() / 2)
  );
}

function getDateStruct(date) {
  return (
    ((((date.getFullYear() - 1980) << 4) | (date.getMonth() + 1)) << 5) |
    date.getDate()
  );
}

module.exports = {
  getTimeStruct,
  getDateStruct,
  calculateSize,
  createByteArray
};
