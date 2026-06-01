// =====================================================
// MEQAL VALVE CONTROL — ELECTRON MAIN PROCESS
// Replaces: Flask app.py + backend.py
// =====================================================

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// =====================================================
// CONFIG (mirrors backend.py)
// =====================================================

const GRID_SIZE = 7;
const VALVE_COUNT = 49;
const FLOW_RATE_LPM = 30.0;
const FLOW_RATE_LPS = FLOW_RATE_LPM / 60.0;
const OPEN_TIME_MS = 500; // 0.5s in ms

// =====================================================
// GLOBAL STATE
// =====================================================

const STATE = {
  running: false,
  active_ids: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45],
  flow_total: 0.0,
  flow_history: [],     // array of { time, value } for charting
  valve_states: new Array(VALVE_COUNT).fill(false),
};

let mainWindow = null;
let gasLoopTimer = null;
let mqttClient = null;
let canBus = null;

// =====================================================
// GENERATE GRID (mirrors backend.generate_grid)
// =====================================================

function generateGrid() {
  const valves = [];
  for (let row = 1; row <= GRID_SIZE; row++) {
    for (let col = 1; col <= GRID_SIZE; col++) {
      const linear_id = (row - 1) * GRID_SIZE + (col - 1);
      valves.push({
        grid: `${row}x${col}`,
        row,
        col,
        linear_id,
        pdo_id: 0x200 + linear_id,
      });
    }
  }
  return valves;
}

const VALVES = generateGrid();

// =====================================================
// MQTT (optional — graceful if not available)
// =====================================================

function setupMqtt() {
  try {
    const mqtt = require("mqtt");
    mqttClient = mqtt.connect("mqtt://localhost:1883", { connectTimeout: 3000 });

    mqttClient.on("connect", () => {
      console.log("[MQTT] Connected to broker");
    });

    mqttClient.on("error", (err) => {
      console.warn("[MQTT] Not available:", err.message);
      mqttClient = null;
    });
  } catch (e) {
    console.warn("[MQTT] Module not available:", e.message);
  }
}

function publishFlow(flowInc) {
  if (!mqttClient) return;
  try {
    mqttClient.publish(
      "valves/flow_inc",
      flowInc.map((v) => v.toFixed(5)).join(",")
    );
  } catch (e) {
    console.warn("[MQTT] Publish failed:", e.message);
  }
}

function publishState(states) {
  if (!mqttClient) return;
  try {
    mqttClient.publish("valve/state", states.join(","));
  } catch (e) {}
}

// =====================================================
// CAN BUS (optional — graceful if not available)
// socketcan only works on Linux with a CAN interface
// =====================================================

function setupCan() {
  try {
    // Try to load node-can if installed
    const can = require("socketcan");
    canBus = can.createRawChannel("can0", true);
    canBus.start();
    console.log("[CAN] Connected to can0");
  } catch (e) {
    console.warn("[CAN] Not available (expected on non-Linux or no CAN hw):", e.message);
    canBus = null;
  }
}

function setPdosForValves(activeIds) {
  if (!canBus) return;

  // Mirror backend.set_pdos_for_valves chunked PDO logic
  const chunks = [
    { id: 0x200, ids: activeIds.slice(0, 10) },
    { id: 0x201, ids: activeIds.slice(10, 20) },
    { id: 0x202, ids: activeIds.slice(20, 30) },
    { id: 0x203, ids: activeIds.slice(30, 40) },
    { id: 0x204, ids: activeIds.slice(40, 49) },
  ];

  for (const chunk of chunks) {
    const data = Buffer.alloc(8, 0);
    chunk.ids.forEach((id, i) => {
      if (i < 4) data.writeUInt16LE(id, i * 2);
    });
    try {
      canBus.send({ id: chunk.id, data, ext: false, rtr: false });
    } catch (e) {
      console.warn("[CAN] Send failed:", e.message);
    }
  }
}

// =====================================================
// GAS LOOP (mirrors backend.send_gas)
// Runs every OPEN_TIME_MS, accumulates flow_total
// =====================================================

function gasLoopTick() {
  if (!STATE.running) return;

  const now = Date.now();
  const flowInc = new Array(VALVE_COUNT).fill(0.0);
  const newStates = new Array(VALVE_COUNT).fill(false);

  for (const v of VALVES) {
    const vid = v.linear_id;
    if (STATE.active_ids.includes(vid)) {
      const increment = FLOW_RATE_LPS * (OPEN_TIME_MS / 1000);
      flowInc[vid] = increment;
      STATE.flow_total += increment;
      newStates[vid] = true;
    }
  }

  STATE.valve_states = newStates;

  // Keep last 60 history points for charting
  STATE.flow_history.push({ time: now, value: STATE.flow_total });
  if (STATE.flow_history.length > 60) STATE.flow_history.shift();

  // Push to hardware (no-ops if not connected)
  setPdosForValves(STATE.active_ids);
  publishFlow(flowInc);
  publishState(newStates.map((s) => (s ? 1 : 0)));

  // Push live update to renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state-update", {
      running: STATE.running,
      active_ids: STATE.active_ids,
      flow_total: STATE.flow_total,
      flow_history: STATE.flow_history,
      valve_states: STATE.valve_states,
    });
  }
}

// =====================================================
// IPC HANDLERS (replaces Flask REST routes)
// =====================================================

// GET state
ipcMain.handle("api:state", () => {
  return {
    running: STATE.running,
    active_ids: STATE.active_ids,
    flow_total: STATE.flow_total,
    flow_history: STATE.flow_history,
    valve_states: STATE.valve_states,
  };
});

// POST /api/start
ipcMain.handle("api:start", () => {
  STATE.running = true;
  if (!gasLoopTimer) {
    gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
  }
  console.log("[SYSTEM] Started");
  return { status: "started" };
});

// POST /api/stop
ipcMain.handle("api:stop", () => {
  STATE.running = false;
  console.log("[SYSTEM] Stopped");
  return { status: "stopped" };
});

// POST /api/emergency
ipcMain.handle("api:emergency", () => {
  STATE.running = false;
  STATE.active_ids = [];
  STATE.valve_states = new Array(VALVE_COUNT).fill(false);

  // Broadcast immediately
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state-update", {
      running: false,
      active_ids: [],
      flow_total: STATE.flow_total,
      flow_history: STATE.flow_history,
      valve_states: STATE.valve_states,
    });
  }

  console.log("[SYSTEM] *** EMERGENCY STOP ***");
  return { status: "EMERGENCY STOP" };
});

// POST /api/valves
ipcMain.handle("api:valves", (event, { active_ids }) => {
  STATE.active_ids = active_ids || [];
  console.log("[VALVES] Active IDs:", STATE.active_ids);
  return { status: "ok", active_ids: STATE.active_ids };
});

// POST /api/reset_total
ipcMain.handle("api:reset_total", () => {
  STATE.flow_total = 0.0;
  STATE.flow_history = [];
  return { status: "reset" };
});

// POST /api/csv — export flow history to Desktop
ipcMain.handle("api:csv", () => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `meqal_flow_${timestamp}.csv`;
    const desktop = require("os").homedir() + "/Desktop/" + filename;

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
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
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

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// =====================================================
// APP LIFECYCLE
// =====================================================

app.whenReady().then(() => {
  setupMqtt();
  setupCan();
  createWindow();

  // Start the gas loop timer always (it checks STATE.running internally)
  gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
});

app.on("window-all-closed", () => {
  if (gasLoopTimer) clearInterval(gasLoopTimer);
  if (mqttClient) mqttClient.end();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
