// Signs a release's SHA256SUMS-<platform>.txt for the mandatory updater (sec-desktop D3), with Node's own
// crypto (Ed25519): no extra tools. release.sh runs it; it is not part of the app.
//   node sign-sums.js <file>               prints the base64 signature of <file>; the private key (PKCS#8 PEM)
//                                          comes from the SNUG_UPDATE_SIGNING_KEY environment variable
//   node sign-sums.js --public             prints the public key of SNUG_UPDATE_SIGNING_KEY
//   node sign-sums.js --new-key <out.pem>  writes a new private key to <out.pem> (owner-only) and prints its
//                                          public key, the line to add to UPDATE_PUBKEYS in updater.js
// Signing refuses a key that updater.js doesn't pin (once it pins any): those clients would refuse the release.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const { UPDATE_PUBKEYS, verifySums } = require("./updater.js");

const die = (m) => { process.stderr.write(`sign-sums.js: ${m}\n`); process.exit(1); };
const pubOf = (key) => crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(12).toString("base64");
function privateKey() {
  const pem = process.env.SNUG_UPDATE_SIGNING_KEY || "";
  if (!pem.trim()) die("SNUG_UPDATE_SIGNING_KEY is not set.");
  let key;
  try { key = crypto.createPrivateKey(pem); } catch { die("SNUG_UPDATE_SIGNING_KEY is not a private key (PKCS#8 PEM)."); }
  if (key.asymmetricKeyType !== "ed25519") die("SNUG_UPDATE_SIGNING_KEY must be an Ed25519 key.");
  return key;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "--new-key") {
  if (!arg) die("usage: node sign-sums.js --new-key <out.pem>");
  if (fs.existsSync(arg)) die(`${arg} already exists; not overwriting it.`);
  const { publicKey, privateKey: priv } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(arg, priv.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  process.stdout.write(`${pubOf(publicKey)}\n`);
} else if (cmd === "--public") {
  process.stdout.write(`${pubOf(privateKey())}\n`);
} else if (cmd && !cmd.startsWith("--")) {
  const key = privateKey();
  const pub = pubOf(key);
  if (UPDATE_PUBKEYS.length && !UPDATE_PUBKEYS.includes(pub)) die("this key is not in UPDATE_PUBKEYS (updater.js): clients would refuse the release.");
  const bytes = fs.readFileSync(cmd);
  const sig = crypto.sign(null, bytes, key).toString("base64");
  if (!verifySums(bytes, sig, [pub])) die("the signature didn't verify.");
  process.stdout.write(`${sig}\n`);
} else {
  die("usage: node sign-sums.js <file> | --public | --new-key <out.pem>");
}
