preact-htm.js is the "htm/preact/standalone" build from htm 3.1.1 (Apache-2.0), which bundles Preact (MIT).
https://github.com/developit/htm  https://github.com/preactjs/preact

--- hpke (written by server/tools/vendor-hpke.mjs) ---
hpke/ holds the plain ES module builds of @hpke/core and @hpke/common (HPKE, RFC 9180), MIT licence,
by Ajitomi Daisuke. https://github.com/dajiaji/hpke-js  https://www.npmjs.com/package/@hpke/core
Only change: `from "@hpke/common"` in core is rewritten to a relative path. SHA256SUMS lists every file after that.
@hpke/common@1.10.1  MIT  sha512-moJwhmtLtuxiUzzNp1jpfBfx8yefKoO9D/RCR9dmwrnc7qjJqId1rEtQz+lSlU5cabX8daToMSx/7HayXOiaFw==
@hpke/core@1.9.0  MIT  sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==
