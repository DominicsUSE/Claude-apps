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

// Code-signing credentials (Windows): a PFX certificate or a SignPath API token. Only signing jobs may see them.
const SIGNING_SECRETS = new Set(["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "SIGNPATH_API_TOKEN"]);
const isSigningJob = (body) => /sign-windows\.ps1 sign|signpath\/github-action-submit-signing-request@/.test(body);

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
      } else if (isSigningJob(body)) {
        // Code signing: in the release environment, nothing installed from npm, only the signing credentials.
        assert.match(body, /^ {4}environment:\s*release\s*$/m, `${name} ${job}: signing runs in environment release`);
        assert.doesNotMatch(body, /npm (ci|install)\b|npx /, `${name} ${job}: no packages installed where the certificate is`);
        for (const m of body.matchAll(/secrets\.(\w+)/g)) assert.ok(SIGNING_SECRETS.has(m[1]), `${name} ${job}: secrets.${m[1]}`);
        assert.doesNotMatch(permsOf(body, 4) || "", /write/, `${name} ${job}: read-only token`);
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

test("(j) Windows code signing switches on with a credential, every signature is checked, unsigned builds still publish", () => {
  const f = files.find((x) => x.name === "build-snug-windows.yml");
  const { jobs } = split(f.text);
  const raw = f.text;
  const signing = Object.entries(jobs).filter(([, b]) => isSigningJob(b));
  assert.deepEqual(signing.map(([j]) => j).sort(), ["sign-app", "sign-installers"], "the app, then the installers around it");
  const on = /vars\.SNUG_WINDOWS_SIGNING == 'signpath' \|\| vars\.SNUG_WINDOWS_SIGNING == 'pfx'/;
  for (const [job, body] of [...signing, ["package-signed", jobs["package-signed"]]]) {
    assert.ok(body, job);
    const cond = /^ {4}if:\s*(.+)$/m.exec(body)?.[1] || "";
    assert.match(cond, on, `${job}: only when signing is set up`);
    assert.match(cond, /refs\/heads\//, `${job}: only on the release branches (the release environment allows no others)`);
  }
  for (const [job, body] of signing) {
    // Both kinds of credential: a PFX through signtool, or SignPath (free for qualifying open-source projects).
    assert.match(body, /if: vars\.SNUG_WINDOWS_SIGNING == 'pfx'[\s\S]*sign-windows\.ps1 sign/, `${job}: PFX`);
    assert.match(body, /if: vars\.SNUG_WINDOWS_SIGNING == 'signpath'[\s\S]*signpath\/github-action-submit-signing-request@[0-9a-f]{40}/, `${job}: SignPath`);
    assert.match(body, /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/);
    assert.match(body, /sign-windows\.ps1 verify/, `${job}: the signature is checked (Get-AuthenticodeSignature)`);
    assert.match(permsOf(body, 4) || "", /actions:\s*read/, `${job}: SignPath reads the run's artifact`);
  }
  // The signed app is wrapped without touching it: fuses and signature checked again after packaging.
  const pkg = jobs["package-signed"];
  assert.match(pkg, /node build\.js --prepackaged dist\/win-unpacked/);
  assert.match(pkg, /node fuses\.js check dist\/win-unpacked\/Snug\.exe/);
  assert.match(pkg, /sign-windows\.ps1 verify dist\/win-unpacked\/Snug\.exe/);
  assert.doesNotMatch(pkg, /secrets\./);
  // The release takes the signed files when signing is on (and never falls back to unsigned then), else today's.
  const rel = jobs.release;
  assert.match(rel, /needs: \[windows, sign-installers\]/);
  assert.match(rel, /needs\.sign-installers\.result == 'success'/);
  assert.match(rel, /vars\.SNUG_WINDOWS_SIGNING == '' && needs\.sign-installers\.result == 'skipped'/);
  assert.match(rel, /name: Snug-Windows-Signed/);
  assert.match(rel, /name: Snug-Windows-Installer/);
  assert.match(rel, /attest-build-provenance@[0-9a-f]{40}/, "provenance stays");
  // A misspelt setting fails the build instead of silently skipping the release.
  assert.match(jobs.windows, /SNUG_WINDOWS_SIGNING/);
  const ps = fs.readFileSync(path.join(__dirname, "sign-windows.ps1"), "utf8");
  assert.match(ps, /Get-AuthenticodeSignature/);
  assert.match(ps, /TimeStamperCertificate/);
  assert.match(ps, /\/fd sha256 \/tr http:\/\/timestamp\.digicert\.com \/td sha256/);
  assert.match(ps, /Remove-Item -LiteralPath \$pfx/, "the certificate file is deleted");
  assert.match(raw, /Azure Trusted Signing/, "the paid option is named, not used");
  // The SignPath artifact configurations the workflow names are in the repository, for the owner to paste.
  for (const slug of ["snug-app", "snug-installers"]) {
    assert.match(raw, new RegExp(`artifact-configuration-slug: ${slug}\\n`));
    assert.match(fs.readFileSync(path.join(__dirname, "signpath", `${slug}.xml`), "utf8"), /<authenticode-sign \/>/);
  }
});

test("(h) every container image is pinned by digest (workflows and the scripts they run)", () => {
  const scripts = fs.readdirSync(path.join(dir, "..", "security")).filter((f) => f.endsWith(".sh"))
    .map((f) => ({ name: `security/${f}`, text: fs.readFileSync(path.join(dir, "..", "security", f), "utf8") }));
  let seen = 0;
  for (const f of [...files, ...scripts]) {
    const t = code(f.text);
    for (const m of t.matchAll(/(?:^\s*image:|^\s*\w*_IMAGE=)\s*"?([^"\s]+)/gm)) {
      seen++;
      assert.match(m[1], /@sha256:[0-9a-f]{64}$/, `${f.name}: ${m[1]}`);
    }
    // `docker run` names its image through one of those pinned variables, or pinned in place.
    for (const m of t.matchAll(/docker run [^\n]*/g)) assert.match(m[0], /"\$\w+_IMAGE"|@sha256:[0-9a-f]{64}/, `${f.name}: ${m[0]}`);
  }
  assert.ok(seen >= 2, "found the semgrep and ZAP images");
});

test("(i) the ZAP baseline scans a seeded server with a read-only token and gates on High only", () => {
  const sec = files.find((x) => x.name === "security.yml");
  const job = split(sec.text).jobs["zap-baseline"];
  assert.ok(job, "security.yml has a zap-baseline job");
  assert.match(permsOf(job, 4) || "", /contents:\s*read/);
  assert.doesNotMatch(permsOf(job, 4) || "", /write/);
  assert.doesNotMatch(job, /secrets\./);
  assert.match(job, /bash \.github\/security\/zap-baseline\.sh/);
  const script = fs.readFileSync(path.join(dir, "..", "security", "zap-baseline.sh"), "utf8");
  assert.match(script, /server\/seed\.js/, "the server has the sample data");
  assert.match(script, /zap-baseline\.py -t "http:\/\/127\.0\.0\.1:\$port"[^\n]*-c rules\.tsv/);
  assert.match(script, /gate\.mjs" zap .*--rules/);
});

test("Dependabot covers Snug's npm folders and the pinned actions", () => {
  const dep = fs.readFileSync(path.join(dir, "..", "dependabot.yml"), "utf8");
  for (const d of ["/snug", "/snug/desktop", "/snug/registry"]) assert.match(dep, new RegExp(`package-ecosystem: npm\\n\\s+directory: ${d}\\n`), d);
  assert.match(dep, /package-ecosystem: github-actions/);
});
