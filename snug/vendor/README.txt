preact-htm.js is the "htm/preact/standalone" build from htm 3.1.1 (Apache-2.0), which bundles Preact (MIT).
https://github.com/developit/htm  https://github.com/preactjs/preact

--- hpke (written by server/tools/vendor-hpke.mjs) ---
hpke/ holds the plain ES module builds of @hpke/core and @hpke/common (HPKE, RFC 9180), MIT licence,
by Ajitomi Daisuke. https://github.com/dajiaji/hpke-js  https://www.npmjs.com/package/@hpke/core
Only change: `from "@hpke/common"` in core is rewritten to a relative path. SHA256SUMS lists every file after that.
@hpke/common@1.10.1  MIT  sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==
@hpke/core@1.9.0  MIT  sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==

pdfjs/pdf.min.js and pdfjs/pdf.worker.min.js are build/pdf.min.mjs and build/pdf.worker.min.mjs from
pdfjs-dist 6.4.299 (Apache-2.0, Mozilla Foundation; pdfjs/LICENSE.txt), renamed .js so the server
serves them as JavaScript. Unchanged otherwise. Loaded only when a PDF attachment comes into view
(js/views/preview.js); the PDF bytes are handed over in memory, never fetched by pdf.js.
https://github.com/mozilla/pdf.js
sha256 (pdf.min.js, pdf.worker.min.js):
  57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2  vendor/pdfjs/pdf.min.js
  9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18  vendor/pdfjs/pdf.worker.min.js
