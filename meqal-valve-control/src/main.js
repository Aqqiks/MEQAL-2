// ============================================================================
// MEQAL VALVE CONTROL — ELECTRON MAIN PROCESS
// ----------------------------------------------------------------------------
// Single source of truth for the valve system. Owns the control loop, the CAN
// bus output, optional MQTT mirroring, and all IPC handlers used by the UI.
//
// Design notes:
//  - The renderer never computes physics. It only sends intent (which valves,
//    which mode, caps, duration) and renders whatever state the main process
//    pushes back. This avoids the UI/backend drift the previous version had.
//  - Native deps (socketcan, mqtt) are OPTIONAL. If they are missing or fail,
//    the app runs in simulation mode and stays fully usable.
//  - Three run modes, mutually exclusive:
//        continuous : every selected valve stays open while running
//        random     : selected valves toggle open/closed at random intervals
//        natural    : each selected valve pulses open->closed->open forever,
//                     each open burst delivering a random 2-5 dL, mirroring the
//                     Python reference (venttiilit open/close cycling)
//  - An optional cumulative per-valve cap (litres) permanently closes a valve
//    in ANY mode once it has delivered that much gas. This is the safety limit.
// ============================================================================

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs   = require("fs");

// ----------------------------------------------------------------------------
// GPU / RENDERING (Raspberry Pi)
// ----------------------------------------------------------------------------
// On the Pi's Wayland desktop, Electron defaults to the X11/XWayland Ozone
// backend, whose GBM buffer manager probes DRM planes on the vc4/v3d driver
// and floods the log with gbm_wrapper "Failed to export buffer to dma_buf"
// errors. The cure is to select the NATIVE Wayland backend via
//   ELECTRON_OZONE_PLATFORM_HINT=auto
// which the launcher (scripts/launch.sh) and the npm start/dev scripts set —
// it must be in the environment BEFORE launch, since Ozone picks its backend
// during early bootstrap (an in-process appendSwitch is too late). We still
// disable hardware acceleration here: this UI is light and software
// compositing is rock-solid on the Pi. Must run before app "ready".
app.disableHardwareAcceleration();

// Only one copy of the app may drive the valves. A second copy (the desktop
// icon clicked again) would send its own "all closed" frames ten times a
// second against the commands of the first one. The second copy exits here,
// before it touches the CAN bus.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  console.warn("[SYSTEM] MEQAL is already running — this second copy is exiting.");
  app.quit();
}

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const GRID_SIZE        = 7;
const VALVE_COUNT      = 49;
const FLOW_RATE_LPM    = 30.0;                 // litres / minute per open valve
const FLOW_RATE_LPS    = FLOW_RATE_LPM / 60.0; // litres / second per open valve
const RAW_CLOSED       = 290;                  // CANopen raw position, closed
const RAW_OPEN         = 370;                  // CANopen raw position, open
const TICK_MS          = 100;                  // control-loop period (physics)
const RANDOM_MIN_MS    = 500;                  // min interval between random toggles
const RANDOM_MAX_MS    = 3000;                 // max interval between random toggles
const MIN_OPEN_MS      = 400;                  // hardware-safe minimum open time
const NATURAL_MIN_DL   = 2;                    // natural burst lower bound (dL)
const NATURAL_MAX_DL   = 5;                    // natural burst upper bound (dL)

// CAN topology — matches the bench hardware confirmed live on the bus: 5
// CANopen controllers at node IDs 1..5, each replying with TPDO1/2/3
// (0x180/0x280/0x380 + node). Each controller drives 10 outputs via three
// RPDOs:
//   RPDO1 0x200+node : that controller's valves 1-4  (UInt16LE each)
//   RPDO2 0x300+node : valves 5-8
//   RPDO3 0x400+node : valves 9-10
// Valve N (1-indexed): node = floor((N-1)/10)+1, local output (N-1)%10.
// Valve 49 -> node 5, local 8 -> RPDO3 0x405 slot 0. (The earlier 13-node /
// 0x201..0x20D attempt only fed outputs 1-4 of each node, which is exactly why
// most valves — and valve 49 — never opened.)
const VALVES_PER_CTRL  = 10;
const NUM_CONTROLLERS  = Math.ceil(VALVE_COUNT / VALVES_PER_CTRL); // 5
const RPDO1_BASE       = 0x200;                // valves 1-4 of each node
const RPDO2_BASE       = 0x300;                // valves 5-8
const RPDO3_BASE       = 0x400;                // valves 9-10
const NMT_ID           = 0x000;               // CANopen NMT command COB-ID
// NMT "start all nodes" init frame, byte-for-byte the proven manual command
// (`cansend can0 000#010027F000000000`). NMT only reads the first two bytes
// (0x01 = start, 0x00 = all nodes); the rest is harmless padding we keep so
// what the app emits is identical to what is known to work on the bench.
const NMT_START_ALL    = Buffer.from([0x01, 0x00, 0x27, 0xF0, 0x00, 0x00, 0x00, 0x00]);
const TX_DRAIN_MS      = 4;                    // pop one CAN frame every 4 ms (mcp251x-safe)
const REFRESH_SWEEP_MS = 100;                  // re-assert every controller this often

// Controller supervision (see CONTROLLER SUPERVISION below). What the
// controllers send back to us:
//   TPDO1 0x180+node : output field values 1-4, mA (UInt16LE each)
//   TPDO2 0x280+node : outputs 5-8
//   TPDO3 0x380+node : outputs 9-10 (then measured feedback of outputs 1-2)
//   EMCY  0x080+node : the controller reporting a fault
//   0x700+node       : boot-up message (data 00) — it has just (re)started
const TPDO1_BASE       = 0x180;
const TPDO2_BASE       = 0x280;
const TPDO3_BASE       = 0x380;
const EMCY_BASE        = 0x080;
const BOOTUP_BASE      = 0x700;
const SUPERVISE_MS     = 250;                  // supervision period
const NODE_TIMEOUT_MS  = 1000;                 // an OPERATIONAL controller reports every 100 ms; silent this long = not obeying
const NODE_GRACE_MS    = 1500;                 // after connecting, wait this long before calling a controller offline
const NMT_RETRY_MS     = 1000;                 // re-send "start" this often while any controller is silent
const MISMATCH_MS      = 1500;                 // output still driven this long after "close" = stuck
const TX_FAIL_LIMIT    = 10;                   // consecutive refused frames before the link is declared failing
const CAN_IFACE        = "can0";               // SocketCAN interface (matches scripts/can-up.sh)
const CAN_RETRY_MS     = 500;                  // check this often whether a lost interface is back up
const CAN_DROP_LOG_MS  = 5000;                 // report a lost link at most this often (it may flap)
const RESTART_WINDOW_MS = 30000;               // a controller restarting RESTART_LIMIT times within this
const RESTART_LIMIT    = 3;                    //   window while running = it cannot carry the load -> stop
const CLOSE_ROUNDS     = 5;                    // all-closed sweeps sent on exit (mirrors the reference shutdown)
const CLOSE_BUDGET_MS  = 800;                  // never let exit hang on a dead bus

// "random" mode is driven by the external Python script, which decides the
// open/closed valve set from the per-valve CSV timing profile and prints it on
// stdout. main.js spawns it, reads that set, and drives the CAN bus + MQTT from
// it (the script no longer talks to CAN/MQTT itself). It is a single ~5s run
// (its own RUN_DURATION): one run per Random activation, then main.js goes idle.
// Stop / Emergency / toggling the mode off kill it early.
const PY_SCRIPT_DIR    = path.join(__dirname, "..", "scripts");
const PY_SCRIPT        = path.join(PY_SCRIPT_DIR, "venttiiliohjaus.py");
const PY_MIN_RUN_MS    = 1000;                 // a faster exit than this = launch failure (just warn)

// ----------------------------------------------------------------------------
// STATE — the one authoritative object
// ----------------------------------------------------------------------------
const STATE = {
  running:        false,
  mode:           "continuous",                     // "continuous" | "random" | "natural"
  active_ids:     [],                               // 1-indexed selected valve IDs
  flow_total:     0.0,                              // total litres since reset
  flow_history:   [],                               // [{ time, value }] for charts
  valve_states:   new Array(VALVE_COUNT + 1).fill(false), // open/closed, index 1..49
  valveFlowAccum: new Array(VALVE_COUNT + 1).fill(0.0),   // cumulative L per valve
  duration:       null,                             // auto-stop ms; null = run until stop
  valveFlowLimit: null,                             // cumulative cap (L) per valve; null = off
  limitedValves:  new Set(),                        // valves permanently closed by the cap
  naturalStates:  {},                               // { id: { open, burstCap, burstFlow, nextSwitch } }
};

// ----------------------------------------------------------------------------
// RUNTIME HANDLES
// ----------------------------------------------------------------------------
let mainWindow            = null;
let controlLoopTimer      = null;
let canRefreshTimer       = null;   // enqueues a full controller sweep
let canTxTimer            = null;   // drains the paced TX queue
let autoStopTimer         = null;
let connectionHealTimer   = null;
let mqttClient            = null;
let canBus                = null;
let canSimulated          = true;
let canTxQueue            = [];      // [{ id, data }] paced out one-per-tick
let canSuperviseTimer     = null;   // controller supervision
let canRetryTimer         = null;   // reopens can0 after it was lost
let canLost               = false;  // hardware present but no usable link; waiting for it
let canEverUp             = false;  // a working link has existed in this session
let canDropLoggedAt       = 0;      // last time a lost link was reported
let canModuleMissing      = false;  // socketcan is not installed at all (pure simulation)
let canWarned             = false;  // "not available" already logged
let canConnectedAt        = 0;      // when the current link was opened
let canTxOk               = true;   // is the kernel accepting our frames?
let canTxFails            = 0;      // consecutive refused frames
let lastNmtAt             = 0;      // last NMT "start" we sent
let lastSuperviseAt       = 0;      // last supervision pass (detects a stalled event loop)
let shuttingDown          = false;  // exit in progress
let pythonProc            = null;    // running venttiiliohjaus.py child, or null
let pythonOpenSet         = new Set(); // open valve ids (1-indexed) the script last reported

// One entry per controller node (index 1..NUM_CONTROLLERS).
const CTRL = Array.from({ length: NUM_CONTROLLERS + 1 }, () => ({
  status:   "unknown",                          // "unknown" | "online" | "offline"
  lastSeen: 0,                                  // time of its last TPDO
  wasOnline: false,                             // has been operational on this link
  boots:    0,                                  // boot-up messages seen since launch
  restarts: [],                                 // recent restart times (restart guard)
  fv:       new Array(VALVES_PER_CTRL).fill(0), // output it reports driving, mA per output
}));
const commanded     = new Array(VALVE_COUNT + 1).fill(false); // what each valve was last told (true = open)
const mismatchSince = new Array(VALVE_COUNT + 1).fill(0);     // when a valve was first seen driven while told to close
let   stuckOpen     = new Set();                              // valves still driven after MISMATCH_MS

// ============================================================================
// MQTT (optional)
// ============================================================================
function setupMqtt() {
  let mqtt;
  try {
    mqtt = require("mqtt");
  } catch (e) {
    console.warn("[MQTT] Module not installed — skipping MQTT mirror.");
    return;
  }
  try {
    mqttClient = mqtt.connect("mqtt://localhost:1883", { connectTimeout: 3000, reconnectPeriod: 0 });
    mqttClient.on("connect", () => console.log("[MQTT] Connected"));
    mqttClient.on("error", (err) => {
      console.warn("[MQTT] Not available:", err.message);
      try { mqttClient.end(true); } catch (_) {}
      mqttClient = null;
    });
  } catch (e) {
    console.warn("[MQTT] Connect failed:", e.message);
    mqttClient = null;
  }
}

function publishFlow(flowInc) {
  if (!mqttClient || !mqttClient.connected) return;
  try { mqttClient.publish("venttiilit/flow_inc", flowInc.slice(1).map(v => v.toFixed(5)).join(",")); } catch (_) {}
}

function publishState(states) {
  if (!mqttClient || !mqttClient.connected) return;
  try { mqttClient.publish("venttiilit/tila", states.slice(1).map(s => (s ? RAW_OPEN : RAW_CLOSED)).join(",")); } catch (_) {}
}

// ============================================================================
// CAN BUS (optional, Linux/socketcan) — falls back to simulation
// ----------------------------------------------------------------------------
// All TX goes through a small paced queue (one frame every TX_DRAIN_MS). The
// Raspberry Pi's mcp251x has only a few hardware TX buffers; blasting all 13
// controller frames at once overflows it (ENOBUFS) and frames silently vanish
// — the "CAN busy, nothing happens" symptom. Pacing mirrors the Python
// reference's per-send sleep and keeps every frame on the wire.
// ============================================================================

// The three RPDO frames for one controller node (1..5), from the open-valve
// set. Node `ctrl` owns 10 valves: local outputs 0-3 -> RPDO1, 4-7 -> RPDO2,
// 8-9 -> RPDO3. Each output is a UInt16LE position (RAW_OPEN / RAW_CLOSED);
// outputs past valve 49 are zero-padded.
function buildCtrlFrames(ctrl, openSet) {
  const base = (ctrl - 1) * VALVES_PER_CTRL; // 0-indexed first valve of node
  const d1 = Buffer.alloc(8, 0);
  const d2 = Buffer.alloc(8, 0);
  const d3 = Buffer.alloc(8, 0);
  for (let local = 0; local < VALVES_PER_CTRL; local++) {
    const vid = base + local + 1; // 1-indexed valve ID
    if (vid > VALVE_COUNT) break;
    const raw = openSet.has(vid) ? RAW_OPEN : RAW_CLOSED;
    if      (local < 4) d1.writeUInt16LE(raw, local * 2);
    else if (local < 8) d2.writeUInt16LE(raw, (local - 4) * 2);
    else                d3.writeUInt16LE(raw, (local - 8) * 2);
  }
  return [
    { id: RPDO1_BASE + ctrl, data: d1 },
    { id: RPDO2_BASE + ctrl, data: d2 },
    { id: RPDO3_BASE + ctrl, data: d3 },
  ];
}

// Frames per full controller sweep: 3 RPDOs each.
const FRAMES_PER_SWEEP = 3 * NUM_CONTROLLERS;

// Enqueue a frame for paced transmission. Bound the queue so a wedged bus can
// never grow it without limit (newest wins — we always want the latest state).
// The bound holds several full sweeps so an emergency 5x close burst is never
// truncated.
function txEnqueue(id, data) {
  if (!canBus) return;
  if (canTxQueue.length > 8 * FRAMES_PER_SWEEP) canTxQueue.shift();
  canTxQueue.push({ id, data });
}

// Hand one frame to the kernel; true if it was accepted. socketcan's send()
// does NOT throw when a frame is refused (queue full, link down, nobody on the
// bus acknowledging) — it returns the syscall result, negative on failure.
// Ignoring that return value is how frames used to vanish without a trace.
function sendNow(f) {
  try {
    const rc = canBus.send({ id: f.id, data: f.data, ext: false, rtr: false });
    return !(typeof rc === "number" && rc < 0);
  } catch (_) {
    return false;
  }
}

// Pop and send exactly one frame. Driven by canTxTimer every TX_DRAIN_MS. A
// refused frame is dropped (the next sweep re-asserts the full state anyway),
// but a run of refusals means nothing is reaching the controllers — say so.
function txDrain() {
  if (!canBus || canTxQueue.length === 0) return;
  if (sendNow(canTxQueue.shift())) {
    canTxFails = 0;
    if (!canTxOk) {
      canTxOk = true;
      console.log("[CAN] Transmit recovered");
      pushStateToRenderer({ notice: "CAN transmit recovered" });
    }
  } else if (++canTxFails === TX_FAIL_LIMIT) {
    canTxOk = false;
    console.warn("[CAN] Transmit FAILING — frames are not leaving the Pi (controllers unpowered, cable/termination, or can0 down). Valves are NOT under control.");
    pushStateToRenderer({ notice: "CAN transmit failing — valves are not under control", notice_error: true });
  }
}

// Queue a full refresh of every controller (all 3 RPDOs each) for the open
// set, and remember what each valve was told so supervision can compare it
// with what the controller reports back.
function enqueueSweep(openSet) {
  for (let v = 1; v <= VALVE_COUNT; v++) commanded[v] = openSet.has(v);
  for (let ctrl = 1; ctrl <= NUM_CONTROLLERS; ctrl++) {
    for (const f of buildCtrlFrames(ctrl, openSet)) txEnqueue(f.id, f.data);
  }
}

// Force every valve on every controller closed. Clears any pending opens first
// so the close jumps the queue. `rounds` repeats the sweep for guaranteed
// delivery (used on emergency, mirroring the reference's 5x close burst).
function sendAllClosed(rounds = 1) {
  if (!canBus) return;
  canTxQueue = [];
  for (let r = 0; r < rounds; r++) enqueueSweep(new Set());
}

// Blocking sleep, used only on the way out when the paced drain timer is gone.
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_CELL, 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// Exit path: command every valve closed and make sure the kernel really took
// each frame. The Pi's CAN transmit queue holds only about a dozen frames, so
// writing all CLOSE_ROUNDS sweeps back-to-back (as this used to) gets most of
// them refused — the later controllers never heard "close" and, since they
// hold their last command, their valves stayed open after the app was gone.
// Here a refused frame is retried once the bus has made room. Returns false
// if the bus would not take the frames within CLOSE_BUDGET_MS.
function closeAllValvesBlocking() {
  const deadline = Date.now() + CLOSE_BUDGET_MS;
  const nothingOpen = new Set();
  canTxQueue = [];
  for (let r = 0; r < CLOSE_ROUNDS; r++) {
    for (let ctrl = 1; ctrl <= NUM_CONTROLLERS; ctrl++) {
      for (const f of buildCtrlFrames(ctrl, nothingOpen)) {
        while (!sendNow(f)) {
          if (Date.now() >= deadline) return false;
          sleepSync(1);
        }
      }
    }
  }
  sleepSync(40); // let the frames still queued in the kernel reach the wire
  return true;
}

// Is the interface administratively up? "up" | "down" | null (no such
// interface). A socket bound to an interface that is DOWN is born with an
// error pending (the kernel flags ENETDOWN at bind), which makes the
// library's receive thread quit at once — so we wait for the link to be up
// instead of opening sockets that die immediately.
function canIfaceState() {
  try {
    const flags = parseInt(fs.readFileSync(`/sys/class/net/${CAN_IFACE}/flags`, "utf8"), 16);
    return (flags & 0x1) ? "up" : "down";
  } catch (_) {
    return null;
  }
}

// Hardware mode without a usable link ("NO CAN"): keep trying until the
// interface is up and opens. Used when a working link drops, and when the
// interface exists but is still down at launch. setupCan() stays quiet and
// opens nothing while the interface is down or gone.
function waitForCan() {
  canLost      = true;
  canSimulated = false;
  if (canRetryTimer) return;
  canRetryTimer = setInterval(() => {
    setupCan();
    if (canBus) { clearInterval(canRetryTimer); canRetryTimer = null; }
  }, CAN_RETRY_MS);
}

function setupCan() {
  if (canBus || shuttingDown) return;
  let can;
  try {
    can = require("socketcan");
  } catch (e) {
    if (!canModuleMissing) console.warn("[CAN] socketcan not installed — running in SIMULATION mode.");
    canModuleMissing = true;
    canBus = null; canSimulated = true;
    return;
  }
  if (canIfaceState() === "down") {
    if (!canLost) console.warn(`[CAN] ${CAN_IFACE} exists but is DOWN — waiting for it to come up (scripts/can-up.sh brings it up).`);
    waitForCan();
    return;
  }
  let chan;
  try {
    chan = can.createRawChannel(CAN_IFACE, true);
    chan.addListener("onMessage", onCanMessage);
    chan.addListener("onStopped", () => onCanStopped(chan));
    chan.start();
  } catch (e) {
    // Never had a link: simulation (retried while idle, see healConnections).
    // Lost a working link: stay in hardware mode ("NO CAN") and keep retrying.
    if (!canLost) {
      if (!canWarned) console.warn("[CAN] Not available:", e.message, "— running in SIMULATION mode.");
      canWarned = true;
      canSimulated = true;
    }
    canBus = null;
    return;
  }

  const firstLink = !canEverUp;
  canEverUp      = true;
  canBus         = chan;
  canSimulated   = false;
  canLost        = false;
  canWarned      = false;
  canTxQueue     = [];
  canTxOk        = true;
  canTxFails     = 0;
  canConnectedAt = Date.now();
  lastSuperviseAt = canConnectedAt;
  stuckOpen      = new Set();
  commanded.fill(false);
  mismatchSince.fill(0);
  for (let n = 1; n <= NUM_CONTROLLERS; n++) {
    const c = CTRL[n];
    c.status = "unknown"; c.lastSeen = 0; c.wasOnline = false; c.restarts = []; c.fv.fill(0);
  }
  console.log(`[CAN] Connected to ${CAN_IFACE}`);

  // Start the paced drain first so anything we enqueue actually goes out.
  if (canTxTimer) clearInterval(canTxTimer);
  canTxTimer = setInterval(txDrain, TX_DRAIN_MS);

  // NMT: move every CANopen node Pre-Operational -> Operational. Send a few
  // times in case a node was still powering up when the first frame went out.
  // Supervision repeats it later for any controller that stays silent.
  for (let i = 0; i < 3; i++) sendNmtStart();

  // While running, the control loop drives CAN in phase with the physics.
  // While idle, re-assert all-closed here so valves are actively held shut
  // and a dropped frame can never leave one stuck open.
  if (canRefreshTimer) clearInterval(canRefreshTimer);
  canRefreshTimer = setInterval(() => {
    if (!STATE.running) enqueueSweep(new Set());
  }, REFRESH_SWEEP_MS);

  if (canSuperviseTimer) clearInterval(canSuperviseTimer);
  canSuperviseTimer = setInterval(superviseControllers, SUPERVISE_MS);

  // The first time a link comes alive, a run may already be "in progress"
  // (started while simulating, or while the interface was still down). Never
  // let that turn into real open valves by itself: stop, and let the operator
  // press Start with the hardware visibly connected.
  if (firstLink && STATE.running) {
    doStop();
    console.warn("[SYSTEM] CAN came up during a run that had no hardware — STOPPED. Press Start to run on the real valves.");
    pushStateToRenderer({ notice: "CAN connected — run stopped. Press Start to run on the real valves.", notice_error: true });
    return;
  }
  pushStateToRenderer();
}

// can0 went away under us (`ip link set can0 down`, adapter unplugged). The
// library's receive thread is gone, so this channel is finished: drop it and
// open a fresh one as soon as the interface is back up. The controllers hold
// their last command meanwhile, so getting back quickly matters most here.
function onCanStopped(chan) {
  if (chan !== canBus || shuttingDown) return; // an old channel, or our own stop()
  if (canTxTimer)        { clearInterval(canTxTimer);        canTxTimer = null; }
  if (canRefreshTimer)   { clearInterval(canRefreshTimer);   canRefreshTimer = null; }
  if (canSuperviseTimer) { clearInterval(canSuperviseTimer); canSuperviseTimer = null; }
  canBus     = null;
  canTxQueue = [];
  stuckOpen  = new Set();
  waitForCan();

  // One message per outage, however often the link flaps.
  const now = Date.now();
  if (now - canDropLoggedAt < CAN_DROP_LOG_MS) { pushStateToRenderer(); return; }
  canDropLoggedAt = now;
  console.warn(`[CAN] ${CAN_IFACE} went down — valves hold their last command until the link is back. Waiting for it…`);
  pushStateToRenderer({ notice: "CAN link lost — valves hold their last command", notice_error: true });
}

function healConnections() {
  if (!mqttClient) setupMqtt();
  // Started without can0: go live as soon as it appears, but only while idle —
  // a simulated run must never turn into real open valves halfway through.
  if (!canBus && !canLost && !canModuleMissing && !STATE.running) setupCan();
}

// ============================================================================
// CONTROLLER SUPERVISION
// ----------------------------------------------------------------------------
// The valve controllers (Axiomatic AX021211) only obey valve commands while
// OPERATIONAL. After every power-up or reset they wait in PRE-OPERATIONAL —
// alive on the bus but ignoring commands — until an NMT "start" arrives, and
// they keep doing whatever they were last told for as long as they have power.
// Sending "start" once at launch is therefore not enough: a controller that
// powered up late, or reset under load, used to stay dead until the app was
// restarted, while the UI happily showed its valves as open. So we listen:
//   - an OPERATIONAL controller reports its outputs every 100 ms (TPDO1/2/3);
//     silence means it is not obeying -> re-send "start" until it answers.
//   - a boot-up message means it has just restarted -> start it right away.
//   - an EMCY message is the controller itself reporting a fault -> log it.
// The reported output values are also compared with what we commanded, so a
// valve that is still being driven after it was told to close gets flagged.
// ============================================================================

function ctrlOf(vid) { return Math.floor((vid - 1) / VALVES_PER_CTRL) + 1; }

function ctrlValves(n) {
  return `${(n - 1) * VALVES_PER_CTRL + 1}-${Math.min(n * VALVES_PER_CTRL, VALVE_COUNT)}`;
}

function sendNmtStart() {
  lastNmtAt = Date.now();
  txEnqueue(NMT_ID, NMT_START_ALL);
}

// Controllers confirmed not responding (empty while simulating / disconnected).
function offlineControllers() {
  const out = [];
  if (!canBus) return out;
  for (let n = 1; n <= NUM_CONTROLLERS; n++) if (CTRL[n].status === "offline") out.push(n);
  return out;
}

// Every frame received from the bus. An exception escaping a socketcan
// listener is fatal to the whole process, so nothing may throw out of here.
function onCanMessage(msg) {
  try {
    if (!msg || msg.ext || msg.rtr || msg.err || !msg.data) return;
    const node = msg.id & 0x7F;
    if (node < 1 || node > NUM_CONTROLLERS) return;
    const fn = msg.id & 0x780;
    const d  = msg.data;

    if (fn === TPDO1_BASE || fn === TPDO2_BASE || fn === TPDO3_BASE) {
      const first = fn === TPDO1_BASE ? 0 : fn === TPDO2_BASE ? 4 : 8;
      const count = fn === TPDO3_BASE ? 2 : 4;
      const fv    = CTRL[node].fv;
      for (let k = 0; k < count && k * 2 + 1 < d.length; k++) fv[first + k] = d.readInt16LE(k * 2);
      controllerSeen(node);
    } else if (fn === BOOTUP_BASE) {
      if (d.length >= 1 && d[0] === 0x00) controllerBooted(node);
    } else if (fn === EMCY_BASE) {
      controllerEmergency(node, d);
    }
  } catch (e) {
    console.warn("[CAN] RX handler error:", e.message);
  }
}

function controllerSeen(n) {
  const c = CTRL[n];
  c.lastSeen = Date.now();
  if (c.status === "online") return;
  const wasOffline = c.status === "offline";
  c.status    = "online";
  c.wasOnline = true;
  console.log(`[CAN] Controller ${n} operational (valves ${ctrlValves(n)})`);
  pushStateToRenderer(wasOffline ? { notice: `Controller ${n} is back — valves ${ctrlValves(n)} under control` } : {});
}

// A controller announced that it has just (re)started. It is PRE-OPERATIONAL
// and its outputs are off; start it now rather than waiting for the timeout.
function controllerBooted(n) {
  const c   = CTRL[n];
  const now = Date.now();
  c.boots++;
  c.fv.fill(0);
  sendNmtStart();

  if (!c.wasOnline) {                      // first power-up since we connected: nothing was lost
    console.log(`[CAN] Controller ${n} booted — starting it`);
    return;
  }
  c.status   = "offline";
  c.restarts = c.restarts.filter(t => now - t < RESTART_WINDOW_MS);
  c.restarts.push(now);
  console.warn(`[CAN] Controller ${n} restarted (boot-up message #${c.boots}) — its valves ${ctrlValves(n)} dropped; starting it again`);

  // Restarting again and again while we are driving valves means the
  // controller cannot carry the load (supply voltage sagging when the coils
  // switch on is the usual cause). Starting it yet again would only repeat
  // the cycle with the valves chattering, so end the run instead.
  if (STATE.running && c.restarts.length >= RESTART_LIMIT) {
    doStop();
    console.warn(`[SYSTEM] Controller ${n} restarted ${c.restarts.length} times in ${RESTART_WINDOW_MS / 1000}s while running — STOPPED. Check the controller's power supply and wiring.`);
    pushStateToRenderer({ notice: `Stopped: controller ${n} keeps restarting under load — check its power supply`, notice_error: true });
    return;
  }
  pushStateToRenderer({ notice: `Controller ${n} restarted — valves ${ctrlValves(n)} dropped`, notice_error: true });
}

// EMCY: bytes 0-1 error code (LE), byte 2 error register, bytes 3-7 device
// specific. The channel/description decode below follows the error-field
// layout in the controller manual and is best-effort; the raw bytes are
// always logged so nothing is lost if it is off.
const EMCY_TEXT = {
  0x0000: "fault cleared",
  0x3000: "supply voltage out of range",
  0x8100: "valve commands timed out",
  0x8130: "heartbeat lost",
  0x8140: "recovered from bus-off",
  0xF002: "output open/short circuit",
};
function controllerEmergency(n, d) {
  if (d.length < 2) return;
  const code = d.readUInt16LE(0);
  const text = EMCY_TEXT[code] || "unknown fault";
  const raw  = d.toString("hex");
  if (code === 0x0000) {
    console.log(`[CAN] Controller ${n}: fault cleared (${raw})`);
    return;
  }
  let detail = text;
  if (code === 0xF002 && d.length >= 4) detail += ` on output ${d[3]} = valve ${(n - 1) * VALVES_PER_CTRL + d[3]}`;
  if (code === 0x3000 && d.length >= 5) detail += d[4] === 0x40 ? " (UNDERVOLTAGE)" : d[4] === 0x20 ? " (overvoltage)" : "";
  console.warn(`[CAN] Controller ${n} reports a fault: ${detail} [EMCY 0x${code.toString(16).padStart(4, "0")}, raw ${raw}]`);
  pushStateToRenderer({ notice: `Controller ${n} fault: ${detail}`, notice_error: true });
}

// Runs every SUPERVISE_MS while a CAN link is open.
function superviseControllers() {
  if (!canBus) return;
  const now = Date.now();
  // If this pass itself ran late, the event loop was blocked and the frames
  // received meanwhile have not been handled yet: silence proves nothing.
  const stalled = now - lastSuperviseAt > 2 * SUPERVISE_MS;
  lastSuperviseAt = now;
  if (stalled) return;

  const lost = [];
  let anyDown = false;

  for (let n = 1; n <= NUM_CONTROLLERS; n++) {
    const c = CTRL[n];
    if (c.status === "online" && now - c.lastSeen > NODE_TIMEOUT_MS) {
      c.status = "offline";
      c.fv.fill(0);
      lost.push(n);
      console.warn(`[CAN] Controller ${n} stopped responding — valves ${ctrlValves(n)} are NOT under control`);
    } else if (c.status === "unknown" && now - canConnectedAt > NODE_GRACE_MS) {
      c.status = "offline";
      lost.push(n);
      console.warn(`[CAN] Controller ${n} is not responding — valves ${ctrlValves(n)} are NOT under control (unpowered, unplugged, or not started)`);
    }
    if (c.status !== "online") anyDown = true;
  }

  // Keep knocking: a silent controller is most likely just PRE-OPERATIONAL.
  if (anyDown && now - lastNmtAt >= NMT_RETRY_MS) sendNmtStart();

  const stuckChanged = checkStuckValves(now);
  if (lost.length) {
    pushStateToRenderer({ notice: `Controller ${lost.join(", ")} not responding — valves not under control`, notice_error: true });
  } else if (stuckChanged) {
    pushStateToRenderer(stuckOpen.size
      ? { notice: `Valve ${Array.from(stuckOpen).join(", ")} still driven although commanded closed`, notice_error: true }
      : {});
  }
}

// A valve the controller keeps driving for MISMATCH_MS after it was told to
// close. Returns true when the set of such valves changed.
function checkStuckValves(now) {
  const stuck = new Set();
  for (let v = 1; v <= VALVE_COUNT; v++) {
    const c  = CTRL[ctrlOf(v)];
    const mA = c.fv[(v - 1) % VALVES_PER_CTRL];
    if (commanded[v] || c.status !== "online" || mA <= 0) { mismatchSince[v] = 0; continue; }
    if (!mismatchSince[v]) mismatchSince[v] = now;
    if (now - mismatchSince[v] >= MISMATCH_MS) stuck.add(v);
  }
  let changed = false;
  for (const v of stuck) {
    if (stuckOpen.has(v)) continue;
    changed = true;
    console.warn(`[CAN] Valve ${v} is commanded CLOSED but controller ${ctrlOf(v)} still reports it driven (${CTRL[ctrlOf(v)].fv[(v - 1) % VALVES_PER_CTRL]} mA)`);
  }
  for (const v of stuckOpen) {
    if (stuck.has(v)) continue;
    changed = true;
    console.log(`[CAN] Valve ${v} is no longer driven`);
  }
  stuckOpen = stuck;
  return changed;
}

// ============================================================================
// MODE HELPERS
// ============================================================================

// The set of valves that are physically open *right now*, per the active mode.
// This is the same logic the CAN refresh and the control loop both rely on.
function openValveSet() {
  if (STATE.mode === "natural") {
    return new Set(STATE.active_ids.filter(id => STATE.naturalStates[id]?.open));
  }
  if (STATE.mode === "random") {
    // Driven by venttiiliohjaus.py: open whatever the script reports, gated by
    // the user's current selection so random still honours the chosen valves.
    return new Set(STATE.active_ids.filter(id => pythonOpenSet.has(id)));
  }
  return new Set(STATE.active_ids); // continuous
}

// ============================================================================
// RANDOM-MODE PYTHON DRIVER
// ----------------------------------------------------------------------------
// In "random" mode the open/closed timing comes from venttiiliohjaus.py (driven
// by venttiilit.csv), NOT from an in-process JS toggle loop. We spawn it, read
// "OPEN:<ids>" lines into pythonOpenSet, and the control loop turns that into
// CAN frames + MQTT + flow exactly like any other mode. CAN/MQTT stay owned here.
// ============================================================================

// Ensure the Python driver is running iff we are actively running in random mode.
function applyRandomDriver() {
  if (STATE.running && STATE.mode === "random") startPythonRandom();
  else stopPythonRandom();
}

function handlePyLine(line) {
  if (!line) return;
  if (line.startsWith("OPEN:")) {
    const rest = line.slice(5).trim();
    pythonOpenSet = rest
      ? new Set(rest.split(",").map(Number).filter(n => n >= 1 && n <= VALVE_COUNT))
      : new Set();
  } else {
    console.log("[PY]", line); // ACTIVE VALVES / [INFO] / [EMERGENCY] / DONE
  }
}

function startPythonRandom() {
  if (pythonProc) return; // already running
  let proc;
  try {
    // -u = unbuffered stdout so we get each OPEN line immediately. cwd is the
    // scripts dir so the script's relative "venttiilit.csv" path resolves.
    proc = spawn("python3", ["-u", PY_SCRIPT], { cwd: PY_SCRIPT_DIR });
  } catch (e) {
    console.warn("[PY] spawn failed:", e.message);
    pythonProc = null;
    return;
  }
  pythonProc = proc;
  const startedAt = Date.now();

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handlePyLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  });
  proc.stderr.on("data", (d) => console.warn("[PY:err]", d.toString().trim()));
  proc.on("error", (e) => {
    console.warn("[PY] process error:", e.message); // e.g. python3 not found
    if (pythonProc === proc) pythonProc = null;
    pythonOpenSet = new Set();
  });
  proc.on("close", (code) => {
    if (pythonProc === proc) pythonProc = null;
    pythonOpenSet = new Set();
    const ranMs = Date.now() - startedAt;
    // One run per Random press: if the script finished on its own while still
    // the active running mode, the run is complete -> go idle. (We do NOT relaunch.)
    // If it exited almost instantly it failed to launch — same outcome (idle),
    // but warn so the cause is visible.
    if (STATE.running && STATE.mode === "random") {
      if (ranMs < PY_MIN_RUN_MS) {
        console.warn(`[PY] exited in ${ranMs}ms (code ${code}) — launch likely failed; check python3 + scripts/venttiilit.csv`);
      } else {
        console.log("[PY] venttiiliohjaus.py run complete — going idle");
      }
      doStop();              // single run finished -> system idle, valves closed
      pushStateToRenderer();
    } else {
      console.log("[PY] venttiiliohjaus.py stopped");
    }
  });
  console.log("[PY] venttiiliohjaus.py started");
}

function stopPythonRandom() {
  pythonOpenSet = new Set();
  if (pythonProc) {
    // SIGTERM -> the script's emergency_handler flips running=False and exits
    // cleanly. running/mode are already cleared, so its close handler won't
    // respawn it.
    try { pythonProc.kill("SIGTERM"); } catch (_) {}
  }
}

function randomInterval() {
  return RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS);
}

// Random 2-5 dL burst expressed in litres.
function randomBurstLitres() {
  return (NATURAL_MIN_DL + Math.random() * (NATURAL_MAX_DL - NATURAL_MIN_DL)) / 10;
}

// Natural mode: each valve starts open with a fresh 2-5 dL burst target. It
// closes once that burst is delivered (respecting MIN_OPEN_MS), pauses for a
// random interval, then reopens with a new burst — pulsing forever, like the
// Python reference's per-valve open/close cycle.
function initNaturalStates() {
  const now = Date.now();
  STATE.naturalStates = {};
  STATE.active_ids.forEach(id => {
    STATE.naturalStates[id] = {
      open: true,
      burstCap:  randomBurstLitres(),
      burstFlow: 0.0,
      openedAt:  now,
    };
  });
}

// ============================================================================
// CONTROL LOOP — runs every TICK_MS while STATE.running
// ============================================================================
function controlLoopTick() {
  if (!STATE.running) return;

  const now       = Date.now();
  const dtSeconds = TICK_MS / 1000;
  const perTick   = FLOW_RATE_LPS * dtSeconds; // litres one open valve delivers per tick
  const newStates = new Array(VALVE_COUNT + 1).fill(false);
  const flowInc   = new Array(VALVE_COUNT + 1).fill(0.0);

  // random mode's open set comes from the Python driver (pythonOpenSet); no JS
  // toggling here. natural still runs its in-process pulse state machine.
  if (STATE.mode === "natural") tickNaturalCloseReopen(now);

  const openSet = openValveSet();

  for (const vid of openSet) {
    if (STATE.limitedValves.has(vid)) continue;

    let add = perTick;

    // Natural mode: never deliver more than THIS valve's own random 2-5 dL
    // burst. Clamping here (not just closing next tick) makes each burst land
    // on exactly its random target, so every valve independently emits its
    // own 2-5 dL before pausing — the per-valve behaviour the bench expects.
    const nat = STATE.mode === "natural" ? STATE.naturalStates[vid] : null;
    if (nat) {
      const remBurst = nat.burstCap - nat.burstFlow;
      if (remBurst <= 0) continue;          // burst already delivered; closes this tick
      if (add > remBurst) add = remBurst;
    }

    // Cumulative safety cap (any mode): clamp the final tick, then retire valve.
    if (STATE.valveFlowLimit != null) {
      const remaining = STATE.valveFlowLimit - STATE.valveFlowAccum[vid];
      if (remaining <= 0) {
        retireValve(vid);
        continue;
      }
      if (add >= remaining) add = remaining;
    }

    STATE.valveFlowAccum[vid] += add;
    STATE.flow_total          += add;
    flowInc[vid]               = add;
    newStates[vid]             = true;
    if (nat) nat.burstFlow    += add;

    // Retire on cumulative cap hit.
    if (STATE.valveFlowLimit != null && STATE.valveFlowAccum[vid] >= STATE.valveFlowLimit) {
      retireValve(vid);
    }
  }

  STATE.valve_states = newStates;
  STATE.flow_history.push({ time: now, value: STATE.flow_total });
  if (STATE.flow_history.length > 600) STATE.flow_history.shift(); // ~60s at 100ms

  // Drive the hardware straight from the valves that are actually open this
  // tick (excludes capped / burst-exhausted ones), in phase with the physics.
  if (canBus) {
    const openNow = new Set();
    for (let v = 1; v <= VALVE_COUNT; v++) if (newStates[v]) openNow.add(v);
    enqueueSweep(openNow);
  }

  publishFlow(flowInc);
  publishState(newStates);
  pushStateToRenderer();
}

// Advance the natural open/close state machine for each active valve.
function tickNaturalCloseReopen(now) {
  STATE.active_ids.forEach(id => {
    let s = STATE.naturalStates[id];
    if (!s) {
      s = STATE.naturalStates[id] = { open: true, burstCap: randomBurstLitres(), burstFlow: 0.0, openedAt: now };
    }
    if (s.open) {
      const heldLongEnough = (now - s.openedAt) >= MIN_OPEN_MS;
      if (s.burstFlow >= s.burstCap && heldLongEnough) {
        s.open       = false;
        s.nextSwitch = now + randomInterval();
      }
    } else if (now >= s.nextSwitch) {
      s.open      = true;
      s.burstCap  = randomBurstLitres();
      s.burstFlow = 0.0;
      s.openedAt  = now;
    }
  });
}

// Permanently close a valve that hit its cumulative cap.
function retireValve(vid) {
  STATE.active_ids = STATE.active_ids.filter(id => id !== vid);
  STATE.limitedValves.add(vid);
  delete STATE.naturalStates[vid];
}

// ============================================================================
// RENDERER PUSH
// ============================================================================
function pushStateToRenderer(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("state-update", snapshot(extra));
}

function snapshot(extra = {}) {
  return {
    running:          STATE.running,
    mode:             STATE.mode,
    active_ids:       STATE.active_ids,
    flow_total:       STATE.flow_total,
    flow_history:     STATE.flow_history,
    valve_states:     STATE.valve_states,
    valve_flow_accum: STATE.valveFlowAccum,
    limited_ids:      Array.from(STATE.limitedValves),
    duration:         STATE.duration,
    valve_flow_limit: STATE.valveFlowLimit,
    can_connected:    !!canBus,
    can_simulated:    canSimulated,
    can_tx_ok:        canTxOk,
    controllers:      CTRL.slice(1).map((c, i) => ({ id: i + 1, status: c.status, boots: c.boots })),
    offline_controllers: offlineControllers(),
    stuck_open_ids:   Array.from(stuckOpen).sort((a, b) => a - b),
    ...extra,
  };
}

// (Re)initialise per-mode bookkeeping for the current selection.
function syncModeStates() {
  if (!STATE.running) return;
  if (STATE.mode === "natural") initNaturalStates();
}

// ============================================================================
// IPC HANDLERS
// ============================================================================
ipcMain.handle("api:state", () => snapshot());

ipcMain.handle("api:start", () => {
  // "Just works": starting with nothing selected opens every valve. In normal
  // (continuous) mode this means Start releases gas through all 49 valves and
  // keeps flowing until the per-valve cap, Stop, or Emergency Stop.
  if (STATE.active_ids.length === 0) {
    STATE.active_ids = Array.from({ length: VALVE_COUNT }, (_, i) => i + 1);
    console.log("[SYSTEM] No selection — defaulting to all 49 valves");
  }
  STATE.running = true;
  syncModeStates();
  applyRandomDriver(); // spawn venttiiliohjaus.py if we're starting in random mode

  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  if (STATE.duration) {
    autoStopTimer = setTimeout(() => {
      doStop();
      autoStopTimer = null;
      pushStateToRenderer({ auto_stopped: true });
      console.log("[SYSTEM] Auto-stopped after", STATE.duration, "ms");
    }, STATE.duration);
  }

  console.log("[SYSTEM] Started — mode:", STATE.mode, "duration:", STATE.duration);
  pushStateToRenderer();
  return { status: "started" };
});

function doStop() {
  STATE.running      = false;
  STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  stopPythonRandom(); // running is now false, so its close handler won't respawn
  sendAllClosed();
}

ipcMain.handle("api:stop", () => {
  doStop();
  pushStateToRenderer();
  console.log("[SYSTEM] Stopped");
  return { status: "stopped" };
});

// Emergency: hard kill. Halt, drop the entire selection, and blast all-closed
// PDOs repeatedly (mirrors the Python shutdown's 5x close burst) so the valves
// are guaranteed shut even if a single frame is lost.
ipcMain.handle("api:emergency", () => {
  STATE.running       = false;
  STATE.active_ids    = [];
  STATE.valve_states  = new Array(VALVE_COUNT + 1).fill(false);
  STATE.naturalStates = {};
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  stopPythonRandom(); // kill the random driver before blasting closes
  sendAllClosed(5); // 5 paced close sweeps, mirroring the reference shutdown
  pushStateToRenderer({ emergency: true });
  console.warn("[SYSTEM] *** EMERGENCY STOP *** all valves forced closed");
  return { status: "EMERGENCY STOP" };
});

ipcMain.handle("api:valves", (_event, { active_ids }) => {
  const incoming = new Set((active_ids || []).filter(id => id >= 1 && id <= VALVE_COUNT));
  // Re-selecting a valve that had hit its cap clears the cap and its counter.
  for (const id of incoming) {
    if (STATE.limitedValves.has(id)) {
      STATE.limitedValves.delete(id);
      STATE.valveFlowAccum[id] = 0.0;
    }
  }
  STATE.active_ids = Array.from(incoming).sort((a, b) => a - b);
  syncModeStates();
  console.log("[VALVES] Active:", STATE.active_ids.length, "valves");
  pushStateToRenderer();
  return { status: "ok", active_ids: STATE.active_ids };
});

ipcMain.handle("api:set_duration", (_event, { duration }) => {
  STATE.duration = (duration && duration > 0) ? duration : null;
  console.log("[DURATION] Set to:", STATE.duration);
  return { status: "ok", duration: STATE.duration };
});

// Mode selector used by the Random / Natural toggle buttons. Passing the mode
// that is already active returns to "continuous" (toggle off).
ipcMain.handle("api:set_mode", (_event, { mode }) => {
  const valid = ["continuous", "random", "natural"];
  STATE.mode = valid.includes(mode) ? mode : "continuous";
  syncModeStates();
  applyRandomDriver(); // launch the Python driver if we just entered random (and are running), else stop it
  console.log("[MODE]", STATE.mode);
  pushStateToRenderer();
  return { status: "ok", mode: STATE.mode };
});

ipcMain.handle("api:set_flow_limit", (_event, { limit }) => {
  STATE.valveFlowLimit = (limit && limit > 0) ? limit : null;
  console.log("[FLOW LIMIT] Set to:", STATE.valveFlowLimit, "L");
  pushStateToRenderer();
  return { status: "ok", limit: STATE.valveFlowLimit };
});

ipcMain.handle("api:reset_total", () => {
  STATE.flow_total     = 0.0;
  STATE.flow_history   = [];
  STATE.valveFlowAccum = new Array(VALVE_COUNT + 1).fill(0.0);
  STATE.limitedValves  = new Set();
  pushStateToRenderer();
  return { status: "reset" };
});

ipcMain.handle("api:reset_caps", () => {
  STATE.valveFlowAccum = new Array(VALVE_COUNT + 1).fill(0.0);
  STATE.limitedValves  = new Set();
  STATE.valveFlowLimit = null;
  console.log("[CAPS] Reset all valve accumulators and limits");
  pushStateToRenderer();
  return { status: "reset" };
});

ipcMain.handle("api:csv", () => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename  = `meqal_flow_${timestamp}.csv`;
    const desktopDir = path.join(require("os").homedir(), "Desktop");
    const outDir    = fs.existsSync(desktopDir) ? desktopDir : require("os").homedir();
    const outPath   = path.join(outDir, filename);

    const rows = ["timestamp,flow_total_litres,active_valve_count"];
    for (const h of STATE.flow_history) {
      rows.push(`${new Date(h.time).toISOString()},${h.value.toFixed(4)},${STATE.active_ids.length}`);
    }
    fs.writeFileSync(outPath, rows.join("\n"));
    console.log("[CSV] Saved to", outPath);
    return { status: "ok", path: outPath };
  } catch (e) {
    console.error("[CSV] Error:", e.message);
    return { status: "error", message: e.message };
  }
});

// ============================================================================
// WINDOW + LIFECYCLE
// ============================================================================
function createWindow() {
  const opts = {
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: "#0b0f14",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // Only set an icon if one actually ships, otherwise Electron warns/throws.
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  if (fs.existsSync(iconPath)) opts.icon = iconPath;

  mainWindow = new BrowserWindow(opts);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.env.NODE_ENV === "development" || process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
  mainWindow.on("closed", () => { mainWindow = null; });
}

if (isPrimaryInstance) app.whenReady().then(() => {
  setupMqtt();
  setupCan();
  createWindow();
  controlLoopTimer    = setInterval(controlLoopTick, TICK_MS);
  connectionHealTimer = setInterval(healConnections, 30000);

  // Optional kiosk/boot behaviour: MEQAL_AUTOSTART=1 selects all valves and
  // starts continuous flow as soon as the app is up. Off by default.
  if (process.env.MEQAL_AUTOSTART === "1") {
    setTimeout(() => {
      STATE.active_ids = Array.from({ length: VALVE_COUNT }, (_, i) => i + 1);
      STATE.running    = true;
      syncModeStates();
      pushStateToRenderer();
      console.log("[SYSTEM] AUTOSTART — all valves, continuous");
    }, 800);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // The desktop icon was clicked while we are already running: show ourselves.
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
});

// Runs once, from whichever exit path comes first (window closed, quit).
function shutdown() {
  if (shuttingDown) return;
  shuttingDown  = true;
  STATE.running = false;
  if (controlLoopTimer)    clearInterval(controlLoopTimer);
  if (canRefreshTimer)     clearInterval(canRefreshTimer);
  if (canTxTimer)          clearInterval(canTxTimer);
  if (canSuperviseTimer)   clearInterval(canSuperviseTimer);
  if (canRetryTimer)       clearInterval(canRetryTimer);
  if (autoStopTimer)       clearTimeout(autoStopTimer);
  if (connectionHealTimer) clearInterval(connectionHealTimer);
  if (pythonProc) { try { pythonProc.kill("SIGTERM"); } catch (_) {} pythonProc = null; }
  // The paced drain is stopping with us, so send the closing frames directly
  // and synchronously here to guarantee every valve is shut on the way out.
  if (canBus) {
    if (closeAllValvesBlocking()) {
      console.log("[SYSTEM] Exit — all valves commanded closed");
    } else {
      console.warn("[SYSTEM] Exit — could NOT deliver the close commands (bus not responding). CHECK THE VALVES.");
    }
  } else if (canLost && canEverUp) {
    console.warn("[SYSTEM] Exit — the CAN link was down, the valves could not be commanded closed. CHECK THE VALVES.");
  }
  try { if (canBus) canBus.stop(); } catch (_) {}
  try { if (mqttClient) mqttClient.end(true); } catch (_) {}
}

// Last line of defence: an unexpected error in the main process must not
// leave valves open with nothing commanding them. Log it, stop, close.
process.on("uncaughtException", (err) => {
  console.error("[SYSTEM] Internal error — stopping and closing all valves:", (err && err.stack) || err);
  try { doStop(); pushStateToRenderer({ notice: "Internal error — system stopped, valves closed", notice_error: true }); } catch (_) {}
});

app.on("window-all-closed", () => {
  shutdown();
  app.quit();
});

app.on("before-quit", shutdown);
