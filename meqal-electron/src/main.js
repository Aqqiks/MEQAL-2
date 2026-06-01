// =====================================================
// MEQAL VALVE CONTROL — ELECTRON MAIN PROCESS
// =====================================================

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs   = require("fs");

// =====================================================
// CONFIG
// =====================================================

const GRID_SIZE        = 7;
const VALVE_COUNT      = 49;
const FLOW_RATE_LPM    = 30.0;
const FLOW_RATE_LPS    = FLOW_RATE_LPM / 60.0;
const OPEN_TIME_MS     = 500;
const RAW_CLOSED       = 290;
const RAW_OPEN         = 370;
const CAN_CTRL_TICK_MS = 20;   // one controller per tick; 20ms × 5 = 100ms full cycle — avoids socketcan buffer overflow at 5ms
const RANDOM_MIN_MS    = 500;
const RANDOM_MAX_MS    = 3000;

// =====================================================
// GLOBAL STATE
// =====================================================

const STATE = {
  running:         false,
  active_ids:      [],                              // 1-indexed valve IDs set by renderer
  flow_total:      0.0,
  flow_history:    [],
  valve_states:    new Array(VALVE_COUNT + 1).fill(false), // index 1–49
  duration:        null,
  random:          false,
  randomStates:    {},
  valveFlowLimit:  null,                            // L per valve; null = no limit
  valveFlowAccum:  new Array(VALVE_COUNT + 1).fill(0.0), // per-valve cumulative flow (L)
  valveFlowCaps:   null,                              // per-valve flow cap in L
  randomCaps:      false,                             // natural random cap mode active
  limitedValves:   new Set(),                         // valve IDs that have hit their limit
};

let mainWindow     = null;
let gasLoopTimer   = null;
let canRefreshTimer = null;
let autoStopTimer  = null;
let mqttClient     = null;
let canBus         = null;
let canSimulated   = false;

// =====================================================
// MQTT (optional)
// =====================================================

function setupMqtt() {
  try {
    const mqtt = require("mqtt");
    mqttClient = mqtt.connect("mqtt://localhost:1883", { connectTimeout: 3000 });
    mqttClient.on("connect", () => console.log("[MQTT] Connected"));
    mqttClient.on("error",   (err) => { console.warn("[MQTT] Not available:", err.message); mqttClient = null; });
  } catch (e) {
    console.warn("[MQTT] Module not available:", e.message);
  }
}

function publishFlow(flowInc) {
  if (!mqttClient) return;
  try { mqttClient.publish("venttiilit/flow_inc", flowInc.slice(1).map(v => v.toFixed(5)).join(",")); } catch (e) {}
}

function publishState(states) {
  if (!mqttClient) return;
  try { mqttClient.publish("venttiilit/tila", states.slice(1).map(s => s ? 1 : 0).join(",")); } catch (e) {}
}

// =====================================================
// CAN BUS — CANopen PDO protocol
// Controller n (1–5) handles valves (n-1)*10+1 … n*10 (1-indexed).
// 3 PDOs per controller: 0x200+n (valves 1–4), 0x300+n (5–8), 0x400+n (9–10).
// Each valve position is a UInt16LE: RAW_CLOSED=290, RAW_OPEN=370.
// =====================================================

// Create a function to send the correct PDOS for the given controller and their set of open valves
// We currently have 5 controllers (1-5) annd 49 valves, so the valves are in 7x7 grid, while one controller controls 10 valves
// Except the last one controls only 9 valves, so we need to be careful with the indexing
function sendCtrlPdos(ctrl, openSet) {
  if (!canBus) return; // safety check, no clocking the can bus if it's not set up
  const base = (ctrl - 1) * 10; // base index for the valves this controller manages
  const vals = []; 
  for (let i = 0; i < 10; i++) {
    const vid = base + i + 1;                   // 1-indexed valve ID
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

function sendAllClosed() {
  if (!canBus) return;
  for (let ctrl = 1; ctrl <= 5; ctrl++) sendCtrlPdos(ctrl, new Set());
}

function setupCan() {
  try {
    const can = require("socketcan");
    canBus = can.createRawChannel("can0", true);
    canBus.start();
    canSimulated = false;
    console.log("[CAN] Connected to can0");

    // NMT Start All Nodes — move every CANopen node Pre-Operational → Operational
    try {
      canBus.send({ id: 0x000, data: Buffer.from([0x01, 0x00]), ext: false, rtr: false });
    } catch (e) { console.warn("[CAN] NMT send failed:", e.message); }

    let refreshCtrl = 1;
    canRefreshTimer = setInterval(() => {
      const ctrl = refreshCtrl;
      refreshCtrl  = (ctrl % 5) + 1;

      const openSet = !STATE.running
        ? new Set()
        : STATE.random
          ? new Set(STATE.active_ids.filter(id => STATE.randomStates[id]?.open))
          : new Set(STATE.active_ids);

      sendCtrlPdos(ctrl, openSet);
    }, CAN_CTRL_TICK_MS);

  } catch (e) {
    console.warn("[CAN] Not available:", e.message);
    canBus = null;
    canSimulated = true;
    console.warn("[CAN] Running in simulation mode.");
  }
}

// =====================================================
// RANDOM MODE
// =====================================================

function initRandomStates() {
  const now = Date.now();
  STATE.active_ids.forEach(id => {
    STATE.randomStates[id] = {
      open: false,
      nextToggle: now + RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS),
    };
  });
}

function tickRandomStates(now) {
  STATE.active_ids.forEach(id => {
    if (!STATE.randomStates[id]) {
      STATE.randomStates[id] = { open: false, nextToggle: now + RANDOM_MIN_MS };
    }
    if (now >= STATE.randomStates[id].nextToggle) {
      STATE.randomStates[id].open = !STATE.randomStates[id].open;
      STATE.randomStates[id].nextToggle = now + RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS);
    }
  });
}

// =====================================================
// GAS LOOP
// =====================================================

function generateRandomValveCaps() {
  const caps = new Array(VALVE_COUNT + 1).fill(null);
  for (let i = 1; i <= VALVE_COUNT; i++) {
    caps[i] = 0.2 + Math.random() * 0.3; // 2–5 dL per valve
  }
  return caps;
}

function gasLoopTick() {
  if (!STATE.running) return;

  const now       = Date.now();
  const flowInc   = new Array(VALVE_COUNT + 1).fill(0.0);
  const newStates = new Array(VALVE_COUNT + 1).fill(false);

  let openIds;
  if (STATE.random) {
    tickRandomStates(now);
    openIds = STATE.active_ids.filter(id => STATE.randomStates[id]?.open);
  } else {
    openIds = STATE.active_ids;
  }

  for (const vid of openIds) {
    const increment = FLOW_RATE_LPS * (OPEN_TIME_MS / 1000);
    const perValveLimit = STATE.valveFlowCaps ? STATE.valveFlowCaps[vid] : null;
    const effectiveLimit = perValveLimit !== null ? perValveLimit : STATE.valveFlowLimit;

    if (effectiveLimit !== null) {
      const newAccum = STATE.valveFlowAccum[vid] + increment;
      if (newAccum >= effectiveLimit) {
        const partial = Math.max(0, effectiveLimit - STATE.valveFlowAccum[vid]);
        STATE.valveFlowAccum[vid] = effectiveLimit;
        if (partial > 0) { flowInc[vid] = partial; STATE.flow_total += partial; }
        STATE.active_ids   = STATE.active_ids.filter(id => id !== vid);
        STATE.limitedValves.add(vid);
        continue;
      }
      STATE.valveFlowAccum[vid] = newAccum;
    }

    flowInc[vid]      = increment;
    STATE.flow_total += increment;
    newStates[vid]    = true;
  }

  STATE.valve_states = newStates;

  STATE.flow_history.push({ time: now, value: STATE.flow_total });
  if (STATE.flow_history.length > 60) STATE.flow_history.shift();

  publishFlow(flowInc);
  publishState(newStates);
  pushStateToRenderer();
}

function pushStateToRenderer(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("state-update", {
    running:         STATE.running,
    active_ids:      STATE.active_ids,
    flow_total:      STATE.flow_total,
    flow_history:    STATE.flow_history,
    valve_states:     STATE.valve_states,
    limited_ids:      Array.from(STATE.limitedValves),
    can_connected:    !!canBus,
    random_caps:      STATE.randomCaps,
    ...extra,
  });
}

// =====================================================
// IPC HANDLERS
// =====================================================

ipcMain.handle("api:state", () => ({
  running:          STATE.running,
  active_ids:       STATE.active_ids,
  flow_total:       STATE.flow_total,
  flow_history:     STATE.flow_history,
  valve_states:     STATE.valve_states,
  duration:         STATE.duration,
  random:           STATE.random,
  random_caps:      STATE.randomCaps,
  limited_ids:      Array.from(STATE.limitedValves),
  valve_flow_limit: STATE.valveFlowLimit,
  can_connected:    !!canBus,
}));

ipcMain.handle("api:start", () => {
  STATE.running = true;

  if (STATE.random) initRandomStates();

  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  if (STATE.duration) {
    autoStopTimer = setTimeout(() => {
      STATE.running      = false;
      STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
      autoStopTimer      = null;
      sendAllClosed();
      pushStateToRenderer({ auto_stopped: true });
      console.log("[SYSTEM] Auto-stopped after", STATE.duration, "ms");
    }, STATE.duration);
  }

  if (!gasLoopTimer) gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
  console.log("[SYSTEM] Started — duration:", STATE.duration, "random:", STATE.random);
  return { status: "started" };
});

ipcMain.handle("api:stop", () => {
  STATE.running      = false;
  STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  sendAllClosed();
  pushStateToRenderer();
  console.log("[SYSTEM] Stopped");
  return { status: "stopped" };
});

ipcMain.handle("api:emergency", () => {
  STATE.running      = false;
  STATE.active_ids   = [];
  STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  sendAllClosed();
  pushStateToRenderer();
  console.log("[SYSTEM] *** EMERGENCY STOP ***");
  return { status: "EMERGENCY STOP" };
});

ipcMain.handle("api:valves", (_event, { active_ids }) => {
  const incoming = new Set(active_ids || []);
  // Re-activating a previously capped valve resets its counter
  for (const id of incoming) {
    if (STATE.limitedValves.has(id)) {
      STATE.limitedValves.delete(id);
      STATE.valveFlowAccum[id] = 0.0;
    }
  }
  STATE.active_ids = Array.from(incoming);
  if (STATE.random && STATE.running) initRandomStates();
  console.log("[VALVES] Active IDs:", STATE.active_ids);
  return { status: "ok", active_ids: STATE.active_ids };
});

ipcMain.handle("api:set_duration", (_event, { duration }) => {
  STATE.duration = duration || null;
  console.log("[DURATION] Set to:", STATE.duration);
  return { status: "ok", duration: STATE.duration };
});

ipcMain.handle("api:set_random", (_event, { enabled }) => {
  STATE.random = !!enabled;
  if (STATE.random && STATE.running) initRandomStates();
  console.log("[RANDOM] Mode:", STATE.random);
  return { status: "ok", random: STATE.random };
});

ipcMain.handle("api:set_random_caps", () => {
  STATE.randomCaps = !STATE.randomCaps;
  if (STATE.randomCaps) {
    STATE.valveFlowCaps = generateRandomValveCaps();
    console.log("[RANDOM CAPS] Enabled — per-valve caps assigned (2–5 dL)");
  } else {
    STATE.valveFlowCaps = null;
    console.log("[RANDOM CAPS] Disabled");
  }
  return { status: "ok", random_caps: STATE.randomCaps };
});

ipcMain.handle("api:set_flow_limit", (_event, { limit }) => {
  STATE.valveFlowLimit = (limit && limit > 0) ? limit : null;
  console.log("[FLOW LIMIT] Set to:", STATE.valveFlowLimit, "L");
  return { status: "ok", limit: STATE.valveFlowLimit };
});

ipcMain.handle("api:reset_total", () => {
  STATE.flow_total     = 0.0;
  STATE.flow_history   = [];
  STATE.valveFlowAccum = new Array(VALVE_COUNT + 1).fill(0.0);
  STATE.limitedValves  = new Set();
  return { status: "reset" };
});

ipcMain.handle("api:csv", () => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename  = `meqal_flow_${timestamp}.csv`;
    const desktop   = require("os").homedir() + "/Desktop/" + filename;

    const rows = ["timestamp,flow_total,active_valve_count"];
    for (const h of STATE.flow_history) {
      rows.push(`${new Date(h.time).toISOString()},${h.value.toFixed(4)},${STATE.active_ids.length}`);
    }

    fs.writeFileSync(desktop, rows.join("\n"));
    console.log("[CSV] Saved to", desktop);
    return { status: "ok", path: desktop };
  } catch (e) {
    console.error("[CSV] Error:", e.message);
    return { status: "error", message: e.message };
  }
});

// =====================================================
// CREATE WINDOW
// =====================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: "#0b0f14",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "../assets/icon.png"),
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  if (process.env.NODE_ENV === "development") mainWindow.webContents.openDevTools();
  mainWindow.on("closed", () => { mainWindow = null; });
}

// =====================================================
// APP LIFECYCLE
// =====================================================

app.whenReady().then(() => {
  setupMqtt();
  setupCan();
  createWindow();
  gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
});

app.on("window-all-closed", () => {
  if (gasLoopTimer)    clearInterval(gasLoopTimer);
  if (canRefreshTimer) clearInterval(canRefreshTimer);
  if (autoStopTimer)   clearTimeout(autoStopTimer);
  sendAllClosed();
  if (mqttClient) mqttClient.end();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
