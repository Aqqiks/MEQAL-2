#!/usr/bin/env node
// ============================================================================
// MEQAL — make sure the two runtime libraries really work
// ----------------------------------------------------------------------------
// The dashboard cannot do its job without:
//   socketcan  the CAN driver (native code, must match this app's Electron)
//   mqtt       the MQTT client
// npm treats both as optional, so when a download or a build fails, `npm
// install` still "succeeds" and the app comes up unable to move a valve. This
// script closes that gap. It loads both libraries inside the app's own
// Electron runtime — the only test that proves anything — and when one is
// missing or was built for the wrong runtime it restores the prebuilt copies
// kept in vendor/ (no network, no compiler needed), then checks again.
//
//   npm run doctor     check only, change nothing
//   npm run setup      check and repair (also runs after every npm install)
//
// Exit code 0 = both libraries load. 1 = the dashboard will not work.
// ============================================================================
"use strict";

const fs   = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT       = path.join(__dirname, "..");
const MODULES    = path.join(ROOT, "node_modules");
const VENDOR_DIR = path.join(ROOT, "vendor");
const CHECK_ONLY = process.argv.includes("--check");
const NEEDED     = ["mqtt", "socketcan"];

const say = (s = "") => process.stdout.write(s + "\n");

// --- 1. the Electron runtime the app runs in --------------------------------
function electronBinary() {
  try {
    const p = require(path.join(MODULES, "electron"));   // the package exports the binary's path
    return typeof p === "string" && fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

// --- 2. load the libraries inside that runtime ------------------------------
function probe(electron) {
  const code = `
    const path = require("path");
    const out = { electron: process.versions.electron, abi: process.versions.modules, libs: {} };
    for (const name of ${JSON.stringify(NEEDED)}) {
      const dir = path.join(${JSON.stringify(MODULES)}, name);
      try {
        require(dir);
        out.libs[name] = { ok: true, version: require(path.join(dir, "package.json")).version };
      } catch (e) {
        out.libs[name] = { ok: false, error: String(e && e.message || e).split("\\n")[0], code: e && e.code };
      }
    }
    process.stdout.write("PROBE" + JSON.stringify(out) + "\\n");`;
  const r = spawnSync(electron, ["-e", code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60000,
  });
  const line = String(r.stdout || "").split("\n").find(l => l.startsWith("PROBE"));
  if (!line) return { error: (r.stderr || r.error || "no output").toString().trim().split("\n").slice(-3).join(" | ") };
  return JSON.parse(line.slice(5));
}

function explain(lib) {
  if (lib.ok) return `OK    ${lib.version}`;
  if (/NODE_MODULE_VERSION|compiled against a different Node|did not self-register|ELF/.test(lib.error)) {
    return "FAIL  installed, but built for a different runtime than this app's Electron (what a plain `npm install` produces)";
  }
  if (/Cannot find module/.test(lib.error) && lib.code === "MODULE_NOT_FOUND") return "FAIL  not installed (download or build failed)";
  return `FAIL  ${lib.error}`;
}

function report(res) {
  for (const name of NEEDED) say(`  ${name.padEnd(10)} ${explain(res.libs[name])}`);
}

// --- 3. the prebuilt copies in vendor/ --------------------------------------
function vendored(res) {
  const major = String(res.electron || "").split(".")[0];
  const file  = path.join(VENDOR_DIR, `runtime-modules-${process.platform}-${process.arch}-electron${major}.tgz`);
  const meta  = path.join(VENDOR_DIR, "runtime-modules.json");
  if (!fs.existsSync(file)) return { file, missing: true };
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(meta, "utf8")); } catch (_) {}
  return { file, manifest, abiMatches: !manifest.abi || String(manifest.abi) === String(res.abi) };
}

function restoreFromVendor(v) {
  fs.mkdirSync(MODULES, { recursive: true });
  const r = spawnSync("tar", ["-xzf", v.file, "-C", MODULES], { encoding: "utf8" });
  return r.status === 0 ? null : (r.stderr || "tar failed").trim();
}

// --- 4. last resort: compile socketcan here ---------------------------------
function rebuildSocketcan() {
  const bin = path.join(MODULES, ".bin", "electron-rebuild");
  if (!fs.existsSync(path.join(MODULES, "socketcan"))) return "socketcan is not in node_modules, so there is nothing to compile";
  if (!fs.existsSync(bin)) return "electron-rebuild is not installed (npm install did not finish)";
  say("  compiling socketcan for this Electron (needs gcc, make, python3 and, the first time, internet)…");
  const r = spawnSync(bin, ["-f", "-w", "socketcan"], { cwd: ROOT, encoding: "utf8", timeout: 600000 });
  return r.status === 0 ? null : ((r.stderr || r.stdout || "failed").trim().split("\n").slice(-4).join("\n      "));
}

// ----------------------------------------------------------------------------
function main() {
  say("MEQAL dependency check");

  const electron = electronBinary();
  if (!electron) {
    say("  electron   FAIL  not installed — `npm install` did not finish.");
    say("");
    say("  Run `npm install` again with a working internet connection. Electron is a");
    say("  ~100 MB download from github.com; if that host is blocked, copy the folder");
    say("  ~/.cache/electron from a machine where it works and run `npm install` again.");
    return 1;
  }

  let res = probe(electron);
  if (res.error) { say(`  could not run Electron: ${res.error}`); return 1; }
  say(`  runtime    Electron ${res.electron} (module version ${res.abi}), ${process.platform}-${process.arch}`);
  report(res);

  const broken = () => NEEDED.filter(n => !res.libs[n].ok);
  if (!broken().length) { say("  All good: the dashboard can talk to the CAN bus and to MQTT."); return 0; }

  if (process.platform !== "linux") {
    say("");
    say("  socketcan only exists on Linux. On this machine the app can run in simulation");
    say("  only (`npm run sim`); the real dashboard runs on the Raspberry Pi.");
    return res.libs.mqtt.ok ? 0 : 1;
  }
  if (CHECK_ONLY) {
    say("");
    say("  The dashboard will NOT work like this. Repair with:  npm run setup");
    return 1;
  }

  // Repair. Prebuilt copies first: fast, offline, and known to work on this rig.
  const v = vendored(res);
  if (v.missing) {
    say(`  no prebuilt copy for this runtime in vendor/ (${path.basename(v.file)})`);
  } else if (!v.abiMatches) {
    say(`  the prebuilt copy in vendor/ is for module version ${v.manifest.abi}, this Electron needs ${res.abi} — not using it`);
  } else {
    say(`  restoring ${broken().join(" and ")} from vendor/${path.basename(v.file)} …`);
    const err = restoreFromVendor(v);
    if (err) say(`  restore failed: ${err}`);
    res = probe(electron);
    report(res);
  }

  if (res.libs.socketcan && !res.libs.socketcan.ok) {
    const err = rebuildSocketcan();
    if (err) say(`  compile failed:\n      ${err}`);
    res = probe(electron);
    report(res);
  }

  if (!broken().length) { say("  Repaired: the dashboard can talk to the CAN bus and to MQTT."); return 0; }

  say("");
  say(`  STILL BROKEN: ${broken().join(", ")}. The dashboard will NOT work like this.`);
  say("  What to try, in order:");
  say("    1. `npm install` again with internet, then `npm run setup`.");
  say("    2. For socketcan: `sudo apt install -y build-essential python3`, then `npm run setup`.");
  say("    3. Copy vendor/ from a working checkout of this project and run `npm run setup`.");
  return 1;
}

process.exit(main());
