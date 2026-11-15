// Electron fuses on a built Snug (sec-desktop D4). CI only, not part of the app.
//   node fuses.js check <app>            fails unless every fuse is as package.json's build.electronFuses says
//   node fuses.js test-copy <app> <dir>  copies the app folder to <dir> and turns on only
//                                        EnableNodeCliInspectArguments in the copy: Playwright's _electron.launch
//                                        always passes --inspect=0, so the release build itself can't be driven.
//                                        The copy is for the packaged-app test and is never uploaded; every other
//                                        fuse is as shipped.
// <app>: dist/win-unpacked/Snug.exe, dist/mac-universal/Snug.app, dist/linux-unpacked/snug-desktop.
"use strict";
const fs = require("fs");
const path = require("path");
const { getCurrentFuseWire, flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");

const want = require("./package.json").build.electronFuses;
const NAMES = {
  runAsNode: "RunAsNode", enableCookieEncryption: "EnableCookieEncryption",
  enableNodeOptionsEnvironmentVariable: "EnableNodeOptionsEnvironmentVariable", enableNodeCliInspectArguments: "EnableNodeCliInspectArguments",
  enableEmbeddedAsarIntegrityValidation: "EnableEmbeddedAsarIntegrityValidation", onlyLoadAppFromAsar: "OnlyLoadAppFromAsar",
  grantFileProtocolExtraPrivileges: "GrantFileProtocolExtraPrivileges",
};
// The fuse states as booleans, by package.json name.
async function read(app) {
  const wire = await getCurrentFuseWire(app);
  const out = {};
  for (const [k, n] of Object.entries(NAMES)) {
    const v = wire[FuseV1Options[n]];
    out[k] = v === "1".charCodeAt(0) || v === 1 ? true : v === "0".charCodeAt(0) || v === 0 ? false : null;
  }
  return out;
}
async function check(app) {
  const got = await read(app);
  const bad = Object.keys(NAMES).filter((k) => typeof want[k] === "boolean" && got[k] !== want[k]);
  for (const k of Object.keys(NAMES)) console.log(`${NAMES[k].padEnd(40)} ${got[k] === null ? "?" : got[k] ? "on" : "off"}${bad.includes(k) ? `   (want ${want[k] ? "on" : "off"})` : ""}`);
  if (bad.length) { console.error(`fuses.js: ${bad.length} fuse(s) not as package.json says`); process.exit(1); }
}
async function testCopy(app, dest) {
  // The folder that holds the app: Snug.app itself on a Mac, the unpacked folder elsewhere.
  const isMacApp = /\.app$/.test(app);
  const from = isMacApp ? app : path.dirname(app);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(from, dest, { recursive: true, verbatimSymlinks: true });
  const copy = isMacApp ? dest : path.join(dest, path.basename(app));
  await flipFuses(copy, { version: FuseVersion.V1, resetAdHocDarwinSignature: isMacApp, [FuseV1Options.EnableNodeCliInspectArguments]: true });
  console.log(copy);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === "check" && a ? check(a) : cmd === "test-copy" && a && b ? testCopy(a, b) : Promise.reject(new Error("usage: node fuses.js check <app> | test-copy <app> <dir>")))
  .catch((e) => { console.error(`fuses.js: ${e.message}`); process.exit(1); });
