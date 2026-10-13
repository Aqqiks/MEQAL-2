#!/usr/bin/env node
// ============================================================================
// MEQAL — refresh the prebuilt copies of mqtt and socketcan in vendor/
// ----------------------------------------------------------------------------
// Run this on a Pi where the dashboard works (`npm run vendor`), then commit
// vendor/. It packs mqtt, socketcan and everything they need at run time —
// including socketcan's compiled driver for this app's Electron — into one
// archive that scripts/ensure-deps.js can restore on a machine where the
// download or the build failed.
//
// Do this again whenever the Electron version in package.json changes, or
// mqtt / socketcan are upgraded: the compiled driver only fits one Electron
// major version.
// ============================================================================
"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT    = path.join(__dirname, "..");
const MODULES = path.join(ROOT, "node_modules");
const VENDOR  = path.join(ROOT, "vendor");
const TOP     = ["mqtt", "socketcan"];
// socketcan lists its build tools as ordinary dependencies; they are not
// needed to run it and would add ~15 MB.
const BUILD_ONLY = new Set(["node-gyp", "nan"]);

const say = (s) => process.stdout.write(s + "\n");

function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === ROOT || dir === path.dirname(dir)) return null;
  }
}

// Every package mqtt and socketcan need, as directories.
function closure() {
  const seen = new Map();
  const todo = TOP.map(n => [n, ROOT]);
  while (todo.length) {
    const [name, from] = todo.pop();
    const dir = findPackage(name, from);
    if (!dir) throw new Error(`${name} (needed by ${path.relative(MODULES, from) || "the app"}) is not installed`);
    if (seen.has(dir)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    seen.set(dir, pkg);
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (!BUILD_ONLY.has(dep)) todo.push([dep, dir]);
    }
  }
  return seen;
}

// Files of one package: everything except other packages nested inside it and
// socketcan's build leftovers (only the two compiled .node files are kept).
function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        if (rel === "build") { for (const f of ["can.node", "can_signals.node"]) { const b = path.join(p, "Release", f); if (fs.existsSync(b)) out.push(b); } continue; }
        walk(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

function main() {
  // Only pack a tree that is known to work.
  const check = spawnSync(process.execPath, [path.join(__dirname, "ensure-deps.js"), "--check"], { encoding: "utf8" });
  process.stdout.write(check.stdout || "");
  if (check.status !== 0) { say("\nNot packing: the libraries do not load here. Fix that first (npm run setup)."); return 1; }

  const electron = require(path.join(MODULES, "electron"));
  const v = spawnSync(electron, ["-e", "process.stdout.write(process.versions.electron + ' ' + process.versions.modules)"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }).stdout.trim().split(" ");
  const [electronVersion, abi] = v;
  const major = electronVersion.split(".")[0];

  const pkgs  = closure();
  const files = [];
  for (const dir of pkgs.keys()) for (const f of filesOf(dir)) files.push(path.relative(MODULES, f));
  files.sort();

  fs.mkdirSync(VENDOR, { recursive: true });
  const archive = path.join(VENDOR, `runtime-modules-${process.platform}-${process.arch}-electron${major}.tgz`);
  const list = path.join(os.tmpdir(), `meqal-vendor-${process.pid}.txt`);
  fs.writeFileSync(list, files.join("\n") + "\n");
  const tar = spawnSync("tar", ["-czf", archive, "-C", MODULES, "-T", list], { encoding: "utf8" });
  fs.unlinkSync(list);
  if (tar.status !== 0) { say("tar failed: " + tar.stderr); return 1; }

  const packages = {};
  for (const [dir, pkg] of pkgs) packages[path.relative(MODULES, dir)] = pkg.version;
  fs.writeFileSync(path.join(VENDOR, "runtime-modules.json"), JSON.stringify({
    created: new Date().toISOString().slice(0, 10),
    platform: process.platform, arch: process.arch,
    electron: electronVersion, abi,
    archive: path.basename(archive),
    packages: Object.fromEntries(Object.entries(packages).sort()),
  }, null, 2) + "\n");

  const kb = Math.round(fs.statSync(archive).size / 1024);
  say(`\nPacked ${pkgs.size} packages, ${files.length} files, ${kb} kB`);
  say(`  vendor/${path.basename(archive)}   (for Electron ${electronVersion}, module version ${abi}, ${process.platform}-${process.arch})`);
  say("  vendor/runtime-modules.json");
  say("Commit both files.");
  return 0;
}

process.exit(main());
