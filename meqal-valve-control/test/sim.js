// ============================================================================
// MEQAL TEST RIG — simulated CAN bus + simulated valve controllers
// ----------------------------------------------------------------------------
// Runs the REAL src/main.js with no hardware and no Electron, against:
//   - a virtual clock (tests run instantly and deterministically),
//   - a model of the Pi's kernel CAN transmit queue (a burst overflows it),
//   - five simulated Axiomatic AX021211 controllers.
//
// The controller model follows the manufacturer's manual (UMAX021211 v4) and
// the configuration read back from the real units over SDO:
//   - After power-up or reset a controller is PRE-OPERATIONAL and ignores
//     valve commands until it gets an NMT "start" (object 5555h is FALSE).
//   - While OPERATIONAL it broadcasts its output state every 100 ms
//     (TPDO1/2/3 on 0x180/0x280/0x380 + node).
//   - Commands arrive on RPDO1/2/3 (0x200/0x300/0x400 + node), four UInt16LE
//     values each. A value below 300 switches the output OFF, otherwise the
//     value is the coil current in mA (2342h = 1, 7320h = 300).
//   - There is no receive timeout (1400h sub 5 = 0): a controller holds the
//     last command forever if commands stop.
// ============================================================================
"use strict";

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

const VALVE_COUNT     = 49;
const VALVES_PER_NODE = 10;

// ----------------------------------------------------------------------------
// Virtual clock
// ----------------------------------------------------------------------------
class Clock {
  constructor(start = Date.UTC(2026, 9, 8, 12, 0, 0)) {
    this.now     = start;
    this._timers = new Map();
    this._id     = 0;
    this._seq    = 0;
  }
  _add(fn, ms, args, repeat) {
    const id = ++this._id;
    ms = Math.max(repeat ? 1 : 0, Number(ms) || 0);
    this._timers.set(id, { id, fn, args, at: this.now + ms, every: repeat ? ms : null, seq: ++this._seq });
    return id;
  }
  setTimeout(fn, ms, ...args)  { return this._add(fn, ms, args, false); }
  setInterval(fn, ms, ...args) { return this._add(fn, ms, args, true); }
  clear(id) { this._timers.delete(id); }

  // Run every timer that falls due within the next `ms`, in time order. Safe
  // to call from inside a timer callback (used to model a blocking sleep).
  advance(ms) {
    const target = this.now + ms;
    for (;;) {
      let next = null;
      for (const t of this._timers.values()) {
        if (t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      if (next.at > this.now) this.now = next.at;
      if (next.every != null) { next.at += next.every; next.seq = ++this._seq; }
      else this._timers.delete(next.id);
      next.fn(...next.args);
    }
    if (target > this.now) this.now = target;
  }
}

// ----------------------------------------------------------------------------
// Simulated AX021211 controller
// ----------------------------------------------------------------------------
class SimNode {
  constructor(bus, id, opts = {}) {
    this.bus    = bus;
    this.id     = id;
    this.state  = "off";                       // off | booting | preop | operational | stopped
    this.pv     = new Array(VALVES_PER_NODE).fill(0); // 7300h, last value received per output
    this.forced = new Map();                   // output index -> mA driven regardless of command
    this.boots  = 0;
    this.bootMs = opts.bootMs ?? 400;
    this.tpdoMs = opts.tpdoMs ?? 100;
    this.maxOpen = opts.maxOpen ?? Infinity;   // weak supply: more outputs than this driven at once -> brown-out reset
    this._tpdoTimer = null;
  }

  get clock() { return this.bus.clock; }
  get powered() { return this.state !== "off"; }

  powerOn() {
    if (this.state !== "off") return;
    this.state = "booting";
    this.pv.fill(0);
    this.clock.setTimeout(() => {
      if (this.state !== "booting") return;
      this.state = "preop";
      this.boots++;
      this.bus.nodeTransmit(this, 0x700 + this.id, Buffer.from([0x00])); // boot-up message
    }, this.bootMs);
  }

  powerOff() {
    this._stopTpdo();
    this.state = "off";
    this.pv.fill(0);
  }

  // Brown-out / watchdog / power glitch: outputs drop, unit restarts and comes
  // back PRE-OPERATIONAL.
  reset() { this.powerOff(); this.powerOn(); }

  // Output field value in mA (object 7330h).
  fv(i) {
    if (this.state === "off" || this.state === "booting") return 0;
    if (this.forced.has(i)) return this.forced.get(i);
    const pv = this.pv[i];
    return pv < 300 ? 0 : Math.min(pv, 1500);
  }

  onFrame(f) {
    if (this.state === "off" || this.state === "booting") return;

    if (f.id === 0x000) {                      // NMT
      if (f.data.length < 2) return;
      const cs = f.data[0], target = f.data[1];
      if (target !== 0 && target !== this.id) return;
      if      (cs === 0x01) this._setState("operational");
      else if (cs === 0x02) this._setState("stopped");
      else if (cs === 0x80) this._setState("preop");
      else if (cs === 0x82) this._setState("preop");   // reset communication: outputs untouched
      else if (cs === 0x81) this.reset();              // reset node
      return;
    }

    if (this.state !== "operational") return;  // PDOs are only processed when OPERATIONAL
    if ((f.id & 0x7F) !== this.id) return;
    const base = f.id & 0x780;
    const first = base === 0x200 ? 0 : base === 0x300 ? 4 : base === 0x400 ? 8 : -1;
    if (first < 0) return;
    if (f.data.length < 8) return;             // shorter than the mapped length: discarded
    for (let k = 0; k < 4 && first + k < VALVES_PER_NODE; k++) {
      this.pv[first + k] = f.data.readUInt16LE(k * 2);
    }
    let driven = 0;
    for (let i = 0; i < VALVES_PER_NODE; i++) if (this.fv(i) > 0) driven++;
    if (driven > this.maxOpen) this.reset();   // supply collapses under the load
  }

  _setState(next) {
    if (next === this.state) return;
    this.state = next;
    if (next === "operational") this._startTpdo();
    else this._stopTpdo();
  }

  _startTpdo() {
    this._stopTpdo();
    this._tpdoTimer = this.clock.setInterval(() => this._tpdo(), this.tpdoMs);
  }
  _stopTpdo() {
    if (this._tpdoTimer != null) { this.clock.clear(this._tpdoTimer); this._tpdoTimer = null; }
  }

  _tpdo() {
    const frame = (vals) => {
      const b = Buffer.alloc(8, 0);
      vals.forEach((v, k) => b.writeUInt16LE(v & 0xFFFF, k * 2));
      return b;
    };
    this.bus.nodeTransmit(this, 0x180 + this.id, frame([0, 1, 2, 3].map(i => this.fv(i))));
    this.bus.nodeTransmit(this, 0x280 + this.id, frame([4, 5, 6, 7].map(i => this.fv(i))));
    // TPDO3: output 9, output 10, then measured feedback of outputs 1 and 2.
    this.bus.nodeTransmit(this, 0x380 + this.id, frame([this.fv(8), this.fv(9), this.fv(0), this.fv(1)]));
  }
}

// ----------------------------------------------------------------------------
// Simulated socket (what node-socketcan's RawChannel looks like to main.js)
// ----------------------------------------------------------------------------
class SimChannel {
  constructor(bus, n) {
    this.bus = bus;
    this.n = n;
    this.started = false;
    this.rxAlive = false;
    this._onMessage = [];
    this._onStopped = [];
  }
  addListener(evt, cb, ctx) {
    if (typeof cb !== "function") throw new Error("Second argument must be a function");
    if (evt === "onMessage") this._onMessage.push({ cb, ctx });
    else if (evt === "onStopped") this._onStopped.push({ cb, ctx });
    else throw new Error("Event not supported");
    return this;
  }
  start() {
    this.started = true;
    this.rxAlive = true;
    this.bus.channels.add(this);
    // The kernel flags ENETDOWN on a socket bound to an interface that is
    // down, so the library's receive thread reports "stopped" straight away
    // (seen with the real app on a real kernel, see the end-to-end test).
    if (!this.bus.up) this.bus.clock.setTimeout(() => { if (this.started && this.rxAlive) this._fireStopped(); }, 1);
    return this;
  }
  // The real library calls the onStopped listeners from stop() as well.
  stop() {
    if (!this.started) throw new Error("Channel not started");
    this._fireStopped();
    this.started = false;
    this.bus.channels.delete(this);
  }
  _fireStopped() {
    this.rxAlive = false;                      // the library's receive thread exits
    for (const l of this._onStopped) l.cb.call(l.ctx);
  }
  // Mirrors the native Send(): never throws on a failed send, it RETURNS the
  // syscall result (16 = frame queued, -1 = rejected).
  send(msg) {
    if (!Buffer.isBuffer(msg.data)) throw new Error("Data field must be a Buffer");
    return this.bus.sockSend(this, msg.id, Buffer.from(msg.data));
  }
  setRxFilters() { return this; }
  disableLoopback() { return this; }
  _deliver(f) {
    if (!this.rxAlive) return;
    for (const l of this._onMessage) l.cb.call(l.ctx, { ts_sec: 0, ts_usec: 0, id: f.id, data: Buffer.from(f.data) });
  }
}

// ----------------------------------------------------------------------------
// Simulated bus + the Pi's kernel transmit queue
// ----------------------------------------------------------------------------
class SimBus {
  constructor(clock, opts = {}) {
    this.clock    = clock;
    this.frameMs  = opts.frameMs  ?? 1;        // ~1 ms per 8-byte frame at 125 kbit/s
    this.queueCap = opts.queueCap ?? 11;       // measured on the Pi: 11-12 of an unpaced burst are accepted
    this.present  = opts.present  ?? true;     // does can0 exist?
    this.up       = opts.up       ?? true;     // is it administratively up?
    this.nodes    = new Map();
    this.channels = new Set();
    this.opened   = 0;                         // how many sockets were ever opened
    this.kq       = [];                        // frames accepted by the kernel, not yet on the wire
    this.wire     = [];                        // frames that reached the wire: { t, id, data, src }
    this.stats    = { accepted: 0, enobufs: 0, enetdown: 0 };
    this._busy    = false;
  }

  addNode(id, opts) { const n = new SimNode(this, id, opts); this.nodes.set(id, n); return n; }

  // -- socket side -----------------------------------------------------------
  open(name) {
    if (!this.present) throw new Error("Error while creating channel");
    this.opened++;
    return new SimChannel(this, this.opened);
  }

  sockSend(chan, id, data) {
    if (!this.up) { this.stats.enetdown++; return -1; }
    if (this.kq.length >= this.queueCap) { this.stats.enobufs++; return -1; }
    this.stats.accepted++;
    this.kq.push({ id, data, src: chan.n });
    this._kick();
    return 16;
  }

  // A frame only leaves the queue once another node acknowledges it. With no
  // controller powered nobody does, so the queue stays full.
  get acked() { for (const n of this.nodes.values()) if (n.powered) return true; return false; }

  _kick() {
    if (this._busy || this.kq.length === 0 || !this.up) return;
    this._busy = true;
    this.clock.setTimeout(() => {
      this._busy = false;
      if (!this.up) return;
      if (!this.acked) { this._kick(); return; } // keeps retransmitting
      const f = this.kq.shift();
      if (f) this._onWire(f);
      this._kick();
    }, this.frameMs);
  }

  _onWire(f) {
    this.wire.push({ t: this.clock.now, id: f.id, data: f.data, src: f.src });
    for (const n of this.nodes.values()) n.onFrame(f);
    for (const c of this.channels) if (c.n !== f.src) c._deliver(f); // other local sockets see it
  }

  nodeTransmit(node, id, data) {
    const f = { id, data, src: "node" + node.id };
    this.wire.push({ t: this.clock.now, id, data, src: f.src });
    if (!this.up) return;
    for (const c of this.channels) c._deliver(f);
  }

  // -- `ip link set can0 down` / `up` ----------------------------------------
  linkDown() {
    this.up = false;
    this.kq = [];
    for (const c of Array.from(this.channels)) c._fireStopped(); // socket reports an error
  }
  linkUp() { this.up = true; this._kick(); }

  // -- what the hardware is actually doing -----------------------------------
  // Valve N (1-indexed) -> controller floor((N-1)/10)+1, output (N-1)%10.
  valveFv(v) {
    const node = this.nodes.get(Math.floor((v - 1) / VALVES_PER_NODE) + 1);
    return node ? node.fv((v - 1) % VALVES_PER_NODE) : 0;
  }
  openValves() {
    const open = [];
    for (let v = 1; v <= VALVE_COUNT; v++) if (this.valveFv(v) > 0) open.push(v);
    return open;
  }
  framesFrom(src) { return this.wire.filter(f => f.src === src); }
  nmtStarts(sinceT = 0) { return this.wire.filter(f => f.id === 0 && f.data[0] === 0x01 && f.t >= sinceT).length; }
}

// ----------------------------------------------------------------------------
// Load src/main.js with stubbed electron / socketcan / mqtt / child_process
// ----------------------------------------------------------------------------
function loadApp(opts = {}) {
  const clock    = opts.clock;
  const bus      = opts.bus;
  const mainPath = opts.mainPath || process.env.MEQAL_MAIN || path.join(__dirname, "..", "src", "main.js");

  const logs = [];
  const fmt  = (a) => a.map(x => (typeof x === "string" ? x : (x instanceof Error ? x.message : JSON.stringify(x)))).join(" ");
  const fakeConsole = {
    log:   (...a) => logs.push({ level: "log",   text: fmt(a) }),
    info:  (...a) => logs.push({ level: "log",   text: fmt(a) }),
    warn:  (...a) => logs.push({ level: "warn",  text: fmt(a) }),
    error: (...a) => logs.push({ level: "error", text: fmt(a) }),
  };

  const ipc = {};
  const appHandlers = {};
  const readyCbs = [];
  const status = { quitCalls: 0, exited: false, windowsCreated: 0, lastPush: null, pushes: 0 };

  const emitApp = (evt, ...args) => { for (const fn of (appHandlers[evt] || []).slice()) fn(...args); };

  class FakeBrowserWindow {
    constructor() {
      status.windowsCreated++;
      this._destroyed = false;
      this._handlers = {};
      this.webContents = {
        send: (channel, data) => { if (channel === "state-update") { status.lastPush = data; status.pushes++; } },
        openDevTools() {},
      };
      FakeBrowserWindow._all.push(this);
    }
    loadFile() { return Promise.resolve(); }
    on(evt, fn) { (this._handlers[evt] ||= []).push(fn); return this; }
    isDestroyed() { return this._destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() {}
    _close() {
      this._destroyed = true;
      FakeBrowserWindow._all = FakeBrowserWindow._all.filter(w => w !== this);
      for (const fn of this._handlers.closed || []) fn();
    }
    static getAllWindows() { return FakeBrowserWindow._all.slice(); }
  }
  FakeBrowserWindow._all = [];

  const fakeApp = {
    disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => opts.singleInstanceLock !== false,
    whenReady: () => ({ then(cb) { readyCbs.push(cb); return this; }, catch() { return this; } }),
    isReady: () => true,
    on(evt, fn) { (appHandlers[evt] ||= []).push(fn); return this; },
    once(evt, fn) { return this.on(evt, fn); },
    focus() {},
    // Electron: quit() emits before-quit (cancellable), closes the windows,
    // then will-quit / quit. window-all-closed is NOT emitted on this path.
    quit() {
      status.quitCalls++;
      if (status.exited) return;
      const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      emitApp("before-quit", ev);
      if (ev.defaultPrevented) return;
      for (const w of FakeBrowserWindow.getAllWindows()) w._close();
      const ev2 = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      emitApp("will-quit", ev2);
      if (ev2.defaultPrevented) return;
      emitApp("quit", {}, 0);
      status.exited = true;
    },
    exit() { status.exited = true; },
  };

  // Random mode spawns python3; tests drive a fake child instead.
  const children = [];
  const fakeSpawn = () => {
    const mk = () => { const h = {}; return { on(e, fn) { (h[e] ||= []).push(fn); }, _emit(e, ...a) { (h[e] || []).forEach(fn => fn(...a)); } }; };
    const proc = mk();
    proc.stdout = mk();
    proc.stderr = mk();
    proc.killed = false;
    proc.kill = () => { if (proc.killed) return; proc.killed = true; proc._emit("close", null); };
    proc.line = (s) => proc.stdout._emit("data", Buffer.from(s + "\n"));
    proc.finish = (code = 0) => { if (!proc.killed) { proc.killed = true; proc._emit("close", code); } };
    children.push(proc);
    return proc;
  };

  const stubs = {
    electron: { app: fakeApp, BrowserWindow: FakeBrowserWindow, ipcMain: { handle(ch, fn) { ipc[ch] = fn; } } },
    socketcan: {
      createRawChannel: (name) => bus.open(name),
      createRawChannelWithOptions: (name) => bus.open(name),
    },
    child_process: { spawn: fakeSpawn },
  };
  // The app reads the interface flags from sysfs; serve the simulated ones.
  const fakeFs = {
    ...fs,
    readFileSync(p, ...rest) {
      if (p === "/sys/class/net/can0/flags") {
        if (!bus.present) { const e = new Error("ENOENT: no such file or directory"); e.code = "ENOENT"; throw e; }
        return bus.up ? "0x40081\n" : "0x40080\n";      // IFF_UP is bit 0
      }
      return fs.readFileSync(p, ...rest);
    },
  };
  const fakeRequire = (name) => {
    if (name === "mqtt") throw new Error("Cannot find module 'mqtt'"); // optional dependency, absent
    if (name === "socketcan" && opts.socketcanMissing) throw new Error("Cannot find module 'socketcan'");
    if (name === "fs") return fakeFs;
    if (stubs[name]) return stubs[name];
    return require(name);
  };

  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  const fakeProcess = {
    env: { ...(opts.env || {}) },
    platform: "linux",
    argv: ["electron", "."],
    pid: 4242,
    on() { return this; },
    once() { return this; },
    exit() { status.exited = true; },
  };
  // A blocking sleep in the app (Atomics.wait) lets virtual time pass, so the
  // simulated kernel queue keeps draining exactly as the real one would.
  const fakeAtomics = { wait: (_ta, _i, _v, ms) => { clock.advance(ms || 0); return "timed-out"; } };

  const src = fs.readFileSync(mainPath, "utf8");
  const params = ["require", "module", "exports", "__dirname", "__filename",
                  "setInterval", "setTimeout", "clearInterval", "clearTimeout",
                  "Date", "process", "console", "Atomics"];
  const fn = vm.compileFunction(src, params, { filename: mainPath });
  const mod = { exports: {} };
  fn(fakeRequire, mod, mod.exports, path.dirname(mainPath), mainPath,
     (f, ms, ...a) => clock.setInterval(f, ms, ...a),
     (f, ms, ...a) => clock.setTimeout(f, ms, ...a),
     (id) => clock.clear(id),
     (id) => clock.clear(id),
     FakeDate, fakeProcess, fakeConsole, fakeAtomics);

  return {
    clock, bus, logs, status, children,
    boot() { for (const cb of readyCbs.splice(0)) cb(); },
    invoke(channel, payload) {
      if (!ipc[channel]) throw new Error("no IPC handler " + channel);
      return ipc[channel]({}, payload);
    },
    state() { return ipc["api:state"]({}); },
    // The user clicks the window's close button.
    closeWindow() {
      for (const w of FakeBrowserWindow.getAllWindows()) w._close();
      emitApp("window-all-closed");
    },
    // Logout / SIGTERM / Ctrl+Q: Electron calls quit() directly.
    quit() { fakeApp.quit(); },
    warnings() { return logs.filter(l => l.level !== "log").map(l => l.text); },
    logText() { return logs.map(l => l.text).join("\n"); },
  };
}

// ----------------------------------------------------------------------------
// Convenience: five controllers, already booted, plus the app.
// ----------------------------------------------------------------------------
function rig(opts = {}) {
  const clock = new Clock();
  const bus   = new SimBus(clock, opts.bus);
  for (let id = 1; id <= 5; id++) bus.addNode(id, opts.node);
  const late = new Set(opts.lateNodes || []);      // not powered when the app starts
  for (const n of bus.nodes.values()) if (!late.has(n.id)) n.powerOn();
  clock.advance(1000);                             // booted -> PRE-OPERATIONAL
  const app = loadApp({ clock, bus, ...(opts.app || {}) });
  app.boot();
  clock.advance(opts.settleMs ?? 500);
  return { clock, bus, app, node: (id) => bus.nodes.get(id) };
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

module.exports = { Clock, SimBus, SimNode, loadApp, rig, range, VALVE_COUNT };
