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
const path = require("path");
const fs   = require("fs");

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
const CAN_CTRL_TICK_MS = 20;                   // 1 controller/tick -> 100ms full sweep
const RANDOM_MIN_MS    = 500;                  // min interval between random toggles
const RANDOM_MAX_MS    = 3000;                 // max interval between random toggles
const MIN_OPEN_MS      = 400;                  // hardware-safe minimum open time
const NATURAL_MIN_DL   = 2;                    // natural burst lower bound (dL)
const NATURAL_MAX_DL   = 5;                    // natural burst upper bound (dL)
const NUM_CONTROLLERS  = Math.ceil(VALVE_COUNT / 10); // 5 controllers, 10 valves each

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
  randomStates:   {},                               // { id: { open, nextToggle } }
  naturalStates:  {},                               // { id: { open, burstCap, burstFlow, nextSwitch } }
};

// ----------------------------------------------------------------------------
// RUNTIME HANDLES
// ----------------------------------------------------------------------------
let mainWindow            = null;
let controlLoopTimer      = null;
let canRefreshTimer       = null;
let autoStopTimer         = null;
let connectionHealTimer   = null;
let mqttClient            = null;
let canBus                = null;
let canSimulated          = true;

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
// ============================================================================

// Build and send the 3 PDOs for one controller (10 valves) given the set of
// currently-open valve IDs. Each position is a UInt16LE (RAW_OPEN/RAW_CLOSED).
//   PDO1 0x200+n : valves 1-4
//   PDO2 0x300+n : valves 5-8
//   PDO3 0x400+n : valves 9-10
function sendCtrlPdos(ctrl, openSet) {
  if (!canBus) return;
  const base = (ctrl - 1) * 10;
  const vals = [];
  for (let i = 0; i < 10; i++) {
    const vid = base + i + 1; // 1-indexed valve ID
    vals.push(vid <= VALVE_COUNT && openSet.has(vid) ? RAW_OPEN : RAW_CLOSED);
  }
  const d1 = Buffer.alloc(8, 0);
  const d2 = Buffer.alloc(8, 0);
  const d3 = Buffer.alloc(8, 0);
  for (let i = 0; i < 4; i++) d1.writeUInt16LE(vals[i],     i * 2);
  for (let i = 0; i < 4; i++) d2.writeUInt16LE(vals[4 + i], i * 2);
  for (let i = 0; i < 2; i++) d3.writeUInt16LE(vals[8 + i], i * 2);
  try {
    canBus.send({ id: 0x200 + ctrl, data: d1, ext: false, rtr: false });
    canBus.send({ id: 0x300 + ctrl, data: d2, ext: false, rtr: false });
    canBus.send({ id: 0x400 + ctrl, data: d3, ext: false, rtr: false });
  } catch (e) {
    console.warn(`[CAN] Send failed ctrl ${ctrl}:`, e.message);
  }
}

// Force every valve on every controller closed. Used on stop / emergency / exit.
function sendAllClosed() {
  if (!canBus) return;
  for (let ctrl = 1; ctrl <= NUM_CONTROLLERS; ctrl++) sendCtrlPdos(ctrl, new Set());
}

function setupCan() {
  let can;
  try {
    can = require("socketcan");
  } catch (e) {
    console.warn("[CAN] socketcan not installed — running in SIMULATION mode.");
    canBus = null; canSimulated = true;
    return;
  }
  try {
    canBus = can.createRawChannel("can0", true);
    canBus.start();
    canSimulated = false;
    console.log("[CAN] Connected to can0");

    // NMT: move every CANopen node Pre-Operational -> Operational.
    try {
      canBus.send({ id: 0x000, data: Buffer.from([0x01, 0x00]), ext: false, rtr: false });
    } catch (e) { console.warn("[CAN] NMT start failed:", e.message); }

    // Refresh one controller per tick so the socketcan TX buffer never floods.
    let refreshCtrl = 1;
    if (canRefreshTimer) clearInterval(canRefreshTimer);
    canRefreshTimer = setInterval(() => {
      const ctrl  = refreshCtrl;
      refreshCtrl = (ctrl % NUM_CONTROLLERS) + 1;
      const openSet = STATE.running ? openValveSet() : new Set();
      sendCtrlPdos(ctrl, openSet);
    }, CAN_CTRL_TICK_MS);
  } catch (e) {
    console.warn("[CAN] Not available:", e.message, "— running in SIMULATION mode.");
    canBus = null; canSimulated = true;
  }
}

function healConnections() {
  if (!mqttClient) setupMqtt();
  if (!canBus && !canSimulated) setupCan();
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
    return new Set(STATE.active_ids.filter(id => STATE.randomStates[id]?.open));
  }
  return new Set(STATE.active_ids); // continuous
}

function randomInterval() {
  return RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS);
}

// Random 2-5 dL burst expressed in litres.
function randomBurstLitres() {
  return (NATURAL_MIN_DL + Math.random() * (NATURAL_MAX_DL - NATURAL_MIN_DL)) / 10;
}

function initRandomStates() {
  const now = Date.now();
  STATE.randomStates = {};
  STATE.active_ids.forEach(id => {
    STATE.randomStates[id] = { open: false, nextToggle: now + randomInterval() };
  });
}

function tickRandomStates(now) {
  STATE.active_ids.forEach(id => {
    let s = STATE.randomStates[id];
    if (!s) { s = STATE.randomStates[id] = { open: false, nextToggle: now + randomInterval() }; }
    if (now >= s.nextToggle) {
      s.open = !s.open;
      // Honour the hardware-safe minimum open time before allowing a close.
      const interval = s.open ? Math.max(MIN_OPEN_MS, randomInterval()) : randomInterval();
      s.nextToggle = now + interval;
    }
  });
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

  if (STATE.mode === "random")  tickRandomStates(now);
  if (STATE.mode === "natural") tickNaturalCloseReopen(now);

  const openSet = openValveSet();

  for (const vid of openSet) {
    if (STATE.limitedValves.has(vid)) continue;

    let add = perTick;

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

    // Track flow toward the current natural burst.
    if (STATE.mode === "natural" && STATE.naturalStates[vid]) {
      STATE.naturalStates[vid].burstFlow += add;
    }

    // Retire on cumulative cap hit.
    if (STATE.valveFlowLimit != null && STATE.valveFlowAccum[vid] >= STATE.valveFlowLimit) {
      retireValve(vid);
    }
  }

  STATE.valve_states = newStates;
  STATE.flow_history.push({ time: now, value: STATE.flow_total });
  if (STATE.flow_history.length > 600) STATE.flow_history.shift(); // ~60s at 100ms

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
  delete STATE.randomStates[vid];
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
    ...extra,
  };
}

// (Re)initialise per-mode bookkeeping for the current selection.
function syncModeStates() {
  if (!STATE.running) return;
  if (STATE.mode === "random")  initRandomStates();
  if (STATE.mode === "natural") initNaturalStates();
}

// ============================================================================
// IPC HANDLERS
// ============================================================================
ipcMain.handle("api:state", () => snapshot());

ipcMain.handle("api:start", () => {
  STATE.running = true;
  syncModeStates();

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
  STATE.randomStates  = {};
  STATE.naturalStates = {};
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  for (let i = 0; i < 5; i++) sendAllClosed();
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

app.whenReady().then(() => {
  setupMqtt();
  setupCan();
  createWindow();
  controlLoopTimer    = setInterval(controlLoopTick, TICK_MS);
  connectionHealTimer = setInterval(healConnections, 30000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  if (controlLoopTimer)    clearInterval(controlLoopTimer);
  if (canRefreshTimer)     clearInterval(canRefreshTimer);
  if (autoStopTimer)       clearTimeout(autoStopTimer);
  if (connectionHealTimer) clearInterval(connectionHealTimer);
  for (let i = 0; i < 5; i++) sendAllClosed();
  try { if (canBus) canBus.stop(); } catch (_) {}
  try { if (mqttClient) mqttClient.end(true); } catch (_) {}
}

app.on("window-all-closed", () => {
  shutdown();
  app.quit();
});

app.on("before-quit", shutdown);
