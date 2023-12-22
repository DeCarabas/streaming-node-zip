This is a very basic implementation of streaming zip support, based on [downzip](https://github.com/robbederks/downzip) by robbiederks.

That implementation was based on the format as described [here](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).

It has been altered to be node.js specific, using buffers and whatnot, and several other things besides, because I want to run this on the server side.
(Running on the server side will let me maybe cache the zip file later if I want to, although the benefits of doing it are unclear.)

It does no compression, which is fine since in its original use case it was streaming JPGs that are already compressed; additional compression would just waste precious CPU cycles.

Unlike downzip, this version has proper flow control, so the zip stream can be piped into the response, and slow clients won't cause us to buffer the whole result in memory.

This code was extracted from a larger express app, and so it makes some assumptions on the shape of the problem to be solved.
In its original place, it was intended to be used as follows:

```javascript
const { zip_files } = require("./zip/archive");

/* ... */
        // Here `resp` is an express response; something that allows for a node.js pipe.
        // `result` is a database query that returned all the URLs that I was going to

        const files = result.rows.map((v, i) => {
          return {
            name: `${i.toString().padStart(3, "0")}.jpg`,
            size: BigInt(v.url_filesize),
            url: v.url
          };
        });

        const zip = await zip_files(files);
        const outname = name.replace('"', '\\"'); // TESTME
        resp.set({
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${outname}.zip"`,
          "Content-Length": zip.total.toString()
        });
        req.logContext.update({ size: zip.total.toString() });
        zip.pipe(resp);

/* ... */
```

It assumes that all of the input streams (a) known in advance, along with their sizes, and (b) are served over HTTP or HTTPS.
Changing the latter is a matter of patching `archive.js` around line 35/
Changing the former is more difficult but I *think* you can construct a zip ala:

```javascript
const { Zip } = require("./zip.js");
const zip = new Zip(0, { zip64: true });
```

and that will work.
Making that work with the `zip_files` function in `archive.js` is a matter of changing line 12 and commenting out line 11.
