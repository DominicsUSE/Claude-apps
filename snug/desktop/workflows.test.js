// sec-desktop D2: rules for every GitHub Actions workflow in the repository, read as text (no YAML parser).
//   node --test snug/desktop/workflows.test.js        (the security workflow's workflow-rules job runs it)
// A compromised dependency or action must not find a token that can publish the release every Snug app
// installs: read-only by default, write only in the job that publishes, actions pinned to a commit, no token
// left in .git/config, and no npm install scripts where a write token is.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "..", ".github", "workflows");
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), "utf8") }));
const code = (t) => t.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n"); // comments out
// Top-level text (before `jobs:`) and each job's text, by job name.
function split(text) {
  const lines = code(text).split("\n");
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = {};
  let cur = null;
  for (const l of lines.slice(at + 1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) { cur = m[1]; jobs[cur] = ""; } else if (cur) jobs[cur] += `${l}\n`;
  }
  return { top: lines.slice(0, at).join("\n"), jobs };
}
const permsOf = (block, indent) => {
  const m = new RegExp(`^ {${indent}}permissions:(.*)\\n((?: {${indent + 2}}.*\\n)*)`, "m").exec(block);
  return m ? m[1] + m[2] : null;
};

test("there are workflows to check", () => assert.ok(files.length >= 3));

test("(a) no workflow grants write at the top level; read-only (or nothing) by default", () => {
  for (const f of files) {
    const p = permsOf(split(f.text).top + "\n", 0);
    assert.ok(p !== null, `${f.name}: top-level permissions are set`);
    assert.doesNotMatch(p, /write/, `${f.name}: top-level permissions are read-only`);
  }
});

test("(b) every action is pinned to a full commit SHA", () => {
  for (const f of files) {
    for (const m of code(f.text).matchAll(/uses:\s*(\S+)/g)) {
      if (m[1].startsWith("./")) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${f.name}: ${m[1]}`);
    }
  }
});

test("(c) every checkout drops the token afterwards (persist-credentials: false)", () => {
  for (const f of files) {
    const lines = code(f.text).split("\n");
    lines.forEach((l, i) => {
      if (!/uses:\s*actions\/checkout@/.test(l)) return;
      const next = lines.slice(i + 1, i + 6).join("\n");
      assert.match(next, /persist-credentials:\s*false/, `${f.name}:${i + 1}`);
    });
  }
});

test("(d) a job that installs npm packages has no write permission; write only where something is published", () => {
  for (const f of files) {
    for (const [job, body] of Object.entries(split(f.text).jobs)) {
      const p = permsOf(body, 4) || "";
      if (/npm (ci|install)\b/.test(body)) assert.doesNotMatch(p, /write/, `${f.name} ${job}: installs packages with a write token`);
      if (/contents:\s*write/.test(p)) assert.match(body, /gh release|release\.sh/, `${f.name} ${job}: contents: write without publishing`);
    }
  }
});

test("(e) Snug's release jobs run in the protected `release` environment; the signing key is only there; builds skip install scripts", () => {
  for (const name of ["build-snug-windows.yml", "build-snug-mac.yml"]) {
    const f = files.find((x) => x.name === name);
    assert.ok(f, name);
    const { jobs } = split(f.text);
    const rel = Object.entries(jobs).filter(([, b]) => /release\.sh/.test(b));
    assert.equal(rel.length, 1, `${name}: one release job`);
    for (const [job, body] of Object.entries(jobs)) {
      if (/release\.sh/.test(body)) {
        assert.match(body, /^ {4}environment:\s*release\s*$/m, `${name} ${job}: environment release`);
        assert.match(body, /SNUG_UPDATE_SIGNING_KEY:\s*\$\{\{\s*secrets\.SNUG_UPDATE_SIGNING_KEY\s*\}\}/, `${name} ${job}: signs the checksums`);
      } else {
        assert.doesNotMatch(body, /secrets\./, `${name} ${job}: no secrets outside the release job`);
        for (const m of body.matchAll(/npm ci[^\n]*/g)) assert.match(m[0], /--ignore-scripts/, `${name} ${job}: ${m[0]}`);
      }
    }
  }
});

test("(f) the built app's fuses are checked, and the packaged test drives a copy, never the uploaded build", () => {
  for (const [name, app] of [["build-snug-windows.yml", "dist/win-unpacked/Snug.exe"], ["build-snug-mac.yml", "dist/mac-universal/Snug.app"]]) {
    const t = code(files.find((x) => x.name === name).text);
    assert.ok(t.includes(`node fuses.js check ${app}`), `${name}: fuse check`);
    assert.match(t, /node fuses\.js test-copy /, `${name}: test copy`);
    assert.doesNotMatch(t, new RegExp(`SNUG_BIN:\\s*${app.replace(/[.]/g, "\\.")}`), `${name}: the test never drives the shipped build directly`);
  }
});

test("(g) no release from another app is ever marked latest", () => {
  for (const f of files) {
    for (const m of code(f.text).matchAll(/gh release create [^\n]*/g)) {
      if (/snug-v|"\$tag"/.test(m[0]) && f.name.startsWith("build-snug")) continue;
      assert.match(m[0], /--latest=false/, `${f.name}: ${m[0]}`);
    }
  }
});

test("Dependabot covers Snug's npm folders and the pinned actions", () => {
  const dep = fs.readFileSync(path.join(dir, "..", "dependabot.yml"), "utf8");
  for (const d of ["/snug", "/snug/desktop", "/snug/registry"]) assert.match(dep, new RegExp(`package-ecosystem: npm\\n\\s+directory: ${d}\\n`), d);
  assert.match(dep, /package-ecosystem: github-actions/);
});
