/* globals BigInt */
const http = require("http");
const https = require("https");

const { calculateSize } = require("./utils");
const { Zip } = require("./zip");

// Create a Zip stream of all of the specified files.
// files is {name: string, size: BigInt, url: string}[]
function zip_files(files) {
  const { total, zip64 } = calculateSize(files);
  const zip = new Zip(total, { zip64 });

  files = files.slice();
  const next_file = () => {
    if (zip.destroyed) {
      return;
    } else if (files.length > 0) {
      const file = files.shift();

      const onabort = () => {
        if (!zip.destroyed) {
          zip.destroy(Error("Aborted"));
        }
      };
      const onerror = e => {
        console.error(e);
        if (!zip.destroyed) {
          zip.destroy(e);
        }
      };

      console.log("Streaming", file.url, "=>", file.name);
      const h = file.url.startsWith("https") ? https : http;
      const req = h.get(file.url, res => {
        res.on("error", onerror);
        res.on("aborted", onabort);
        res.pipe(zip.startFile(file.name)).on("finish", next_file);
      });
      req.on("abort", onabort);
      req.on("error", onerror);
      req.on("timeout", onabort);
    } else {
      zip.finish();
    }
  };
  next_file(); // Kick it off.

  return zip;
}

module.exports = { zip_files };
