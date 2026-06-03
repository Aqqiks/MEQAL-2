
// MEQAL VALVE CONTROL — ELECTRON MAIN PROCESS
// This Electron main process script manages the core logic of the MEQAL valve control system, including state management, 
// CAN bus communication, MQTT integration, and IPC handlers for interaction with the renderer process.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs   = require("fs");


// CONFIG
// These constants define the configuration parameters for the system, such as the number of valves, flow rates, timing intervals, and raw values for open/closed states.
const GRID_SIZE        = 7;
const VALVE_COUNT      = 49;
const FLOW_RATE_LPM    = 30.0;
const FLOW_RATE_LPS    = FLOW_RATE_LPM / 60.0;
const OPEN_TIME_MS     = 500;
const RAW_CLOSED       = 290;
const RAW_OPEN         = 370;
const CAN_CTRL_TICK_MS = 20;   // one controller per tick; 20ms x 5 = 100ms full cycle - avoids socketcan buffer overflow at 5ms
const RANDOM_MIN_MS    = 500;
const RANDOM_MAX_MS    = 3000;


// GLOBAL STATE
// The STATE object holds the current state of the system, including whether it's running, which valves are active, total flow, flow history, valve states, duration, 
// random mode status, flow limits, and more.
const STATE = {
  running:         false,                           // whether the system is currently running
  active_ids:      [],                              // 1-indexed valve IDs set by renderer
  flow_total:      0.0,                             // total flow in liters since start               
  flow_history:    [],                              // array of { time, value } for graphing flow over time
  valve_states:    new Array(VALVE_COUNT + 1).fill(false), // index 1~49
  duration:        null,                            // auto-stop duration in ms; null = no auto-stop
  random:          false,                           // whether random mode is active (valves toggle randomly while active)
  randomStates:    {},                              // per-valve random state and next toggle time when in random mode
  valveFlowLimit:  null,                            // L per valve; null = no limit
  valveFlowAccum:  new Array(VALVE_COUNT + 1).fill(0.0), // per-valve cumulative flow (L)
  valveFlowCaps:   null,                            // per-valve flow cap in L
  randomCaps:           false,                      // natural random cap mode active
  limitedValves:        new Set(),                  // valve IDs that have hit their limit
  naturalCycleStates:   {},                         // per-valve cycle state for natural mode { phase, nextSwitch }
};

// These variables will hold references to the main application window, timers for the gas loop and CAN refresh, the MQTT client, the CAN bus channel, 
// -> and a flag for whether we're simulating the CAN bus.
let mainWindow     = null;                          // reference to the main application window
let gasLoopTimer   = null;                          // timer for the main gas loop that updates flow and states
let canRefreshTimer = null;                         // timer for refreshing the CAN bus with the current valve states at regular intervals
let autoStopTimer  = null;                          // timer for auto-stopping the system after a specified duration
let mqttClient     = null;                          // MQTT client instance for publishing flow and state updates to an MQTT broker
let canBus         = null;                          // CAN bus channel for communicating with the valve controllers; if null, CAN is not available
let canSimulated   = false;                         // flag to indicate if we're running in simulation mode without actual CAN communication (e.g., if socketcan is not available or
//                                                     can0 interface cannot be accessed)

// MQTT

// Create a connection to MQTT server, we host it on port 1883, connect timeout only when system down
// Log message when connected successfully and if there is an error etc, log it if there is an error message
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

// Publish topic to venttiilit csv into flow_inc topic
function publishFlow(flowInc) {
  if (!mqttClient) return;
  try { mqttClient.publish("venttiilit/flow_inc", flowInc.slice(1).map(v => v.toFixed(5)).join(",")); } catch (e) {}
}

// Publish topic to venttiilit csv into tila topic
function publishState(states) {
  if (!mqttClient) return;
  try { mqttClient.publish("venttiilit/tila", states.slice(1).map(s => s ? 1 : 0).join(",")); } catch (e) {}
}

// Create a function to send the correct PDOS for the given controller and their set of open valves
// We currently have 5 controllers (1-5) annd 49 valves, so the valves are in 7x7 grid, while one controller controls 10 valves
// Except the last one controls only 9 valves, so we need to be careful with the indexing
// Each valve position is a UInt16LE: RAW_CLOSED=290, RAW_OPEN=370.
// There are 3 pdos per controller 0x200+n (valves 1~4), 0x300+n (5~8), 0x400+n (9~10).
function sendCtrlPdos(ctrl, openSet) {
  if (!canBus) return; // safety check, no clocking the can bus if it's not set up
  const base = (ctrl - 1) * 10; // base index for the valves this controller manages
  const vals = []; 
  for (let i = 0; i < 10; i++) {
    const vid = base + i + 1;                   // 1-indexed valve ID
    vals.push(vid <= VALVE_COUNT && openSet.has(vid) ? RAW_OPEN : RAW_CLOSED);
  }
  // Construct the 3 PDO data buffers
  const d1 = Buffer.alloc(8, 0);
  const d2 = Buffer.alloc(8, 0);
  const d3 = Buffer.alloc(8, 0);
  // Write the valve states into the PDO buffers
  for (let i = 0; i < 4; i++) d1.writeUInt16LE(vals[i],     i * 2);
  for (let i = 0; i < 4; i++) d2.writeUInt16LE(vals[4 + i], i * 2);
  for (let i = 0; i < 2; i++) d3.writeUInt16LE(vals[8 + i], i * 2);
  try {
    // Send the PDO buffers to the CAN bus with appropriate IDs and flags
    // Note: if the bus is not available, this will throw an error which we catch to avoid crashing the app
    canBus.send({ id: 0x200 + ctrl, data: d1, ext: false, rtr: false });
    canBus.send({ id: 0x300 + ctrl, data: d2, ext: false, rtr: false });
    canBus.send({ id: 0x400 + ctrl, data: d3, ext: false, rtr: false });
    // For debugging, we can log the error messages if the send fails
  } catch (e) {
    console.warn(`[CAN] Send failed ctrl ${ctrl}:`, e.message);
  }
}

// Send closed state for all valves on all controllers, used when stopping or in emergency
// -> We loop through all 5 controllers and call sendCtrlPdos with an empty set of open valves, which will cause all valves to be sent as closed
function sendAllClosed() {
  if (!canBus) return; // safety check, no clocking the can bus if it's not set up
  for (let ctrl = 1; ctrl <= 5; ctrl++) sendCtrlPdos(ctrl, new Set());
}

// Set up the CAN bus connection and start the refresh timer to send PDOs at regular intervals based on the current state of the valves
// Code goes like this - try to require socketcan and create a raw channel for can0, if it fails we log a warning and set canSimulated to true
// -> If the connection is successful, we start the channel and set up a timer to send control PDOs every CAN_CTRL_TICK_MS milliseconds, which will call sendCtrlPdos with the appropriate controller number and the set of currently open valves for that controller
// -> The sendCtrlPdos function constructs the PDO data buffers based on which valves are open or closed and sends them to the CAN bus with the correct IDs
function setupCan() {
  try { // We attempt to set up the CAN bus connection using the socketcan module. If the module is not available or if there is an error accessing the can0 interface, we catch the error and log a warning, then set canBus to null and canSimulate'
  // -> to true to indicate that we're running in simulation mode without actual CAN communication.
    const can = require("socketcan");
    canBus = can.createRawChannel("can0", true);
    canBus.start();
    canSimulated = false;
    console.log("[CAN] Connected to can0");
    // NMT Start All Nodes — move every CANopen node Pre-Operational -> Operational
    try {
      canBus.send({ id: 0x000, data: Buffer.from([0x01, 0x00]), ext: false, rtr: false });
    } catch (e) { console.warn("[CAN] NMT send failed:", e.message); }
    // Start the timer to refresh the CAN bus with the current valve states at regular intervals
    let refreshCtrl = 1;
    canRefreshTimer = setInterval(() => {
      const ctrl = refreshCtrl;
      refreshCtrl  = (ctrl % 5) + 1;
      // Determine which valves are currently open for this controller based on the global state and whether we're in random mode or not
      const openSet = !STATE.running
        ? new Set()
        : STATE.randomCaps
          ? new Set(STATE.active_ids.filter(id => STATE.naturalCycleStates[id]?.phase === 'open'))
          : STATE.random
            ? new Set(STATE.active_ids.filter(id => STATE.randomStates[id]?.open))
            : new Set(STATE.active_ids);
      // Send the PDOs for this controller with the current open valves
      sendCtrlPdos(ctrl, openSet);
    }, CAN_CTRL_TICK_MS);

  // If the socketcan module is not available or the can0 interface cannot be accessed, we catch the error and log a warning, then set canBus to null and canSimulated to true to indicate that we're running in simulation mode without actual CAN communication
  } catch (e) {
    console.warn("[CAN] Not available:", e.message);
    canBus = null;
    canSimulated = true;
    console.warn("[CAN] Running in simulation mode.");
  }
}

// RANDOM MODE
// In random mode, the valves in active_ids toggle open/closed at random intervals between RANDOM_MIN_MS and RANDOM_MAX_MS. 
// This is implemented by maintaining a randomStates object that tracks the current open state and next toggle time for each active valve ID. 
// The tickRandomStates function is called on each gas loop tick to update the states based on the current time, and initRandomStates initializes
// -> the random states when random mode is enabled or when the active IDs change while running.
function initRandomStates() {
  const now = Date.now();
  STATE.active_ids.forEach(id => {
    STATE.randomStates[id] = {
      open: false,
      nextToggle: now + RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS),
    };
  });
}

// This function is called on each gas loop tick to update the random states of the active valves based on the current time. 
// It iterates through the active_ids and checks if each valve has a random state. If not, it initializes it with a closed state and a next toggle time. 
// Then it checks if the current time has reached or passed the next toggle time for each valve, and if so, it toggles the open state and sets 
// -> a new next toggle time for that valve.
function tickRandomStates(now) {
  STATE.active_ids.forEach(id => {
    if (!STATE.randomStates[id]) { // safety check in case active_ids changed without re-initializing random states; we initialize any missing entries to ensure the toggling logic works correctly
      STATE.randomStates[id] = { open: false, nextToggle: now + RANDOM_MIN_MS };
    }
    if (now >= STATE.randomStates[id].nextToggle) { // time to toggle this valve's state
      STATE.randomStates[id].open = !STATE.randomStates[id].open;
      STATE.randomStates[id].nextToggle = now + RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS);
    }
  });
}

// NATURAL CYCLE MODE
// Mirrors the Python system: each valve opens for (cap / FLOW_RATE_LPS) seconds, then closes for a random
// interval (RANDOM_MIN_MS–RANDOM_MAX_MS), then reopens with a new random cap. Repeats while running.

function initNaturalCycleStates() {
  const now = Date.now();
  STATE.naturalCycleStates = {};
  STATE.active_ids.forEach(id => {
    const cap   = STATE.valveFlowCaps ? STATE.valveFlowCaps[id] : 0.2 + Math.random() * 0.3;
    const openMs = (cap / FLOW_RATE_LPS) * 1000;
    STATE.naturalCycleStates[id] = { phase: 'open', nextSwitch: now + openMs };
  });
}

function tickNaturalCycleStates(now) {
  STATE.active_ids.forEach(id => {
    if (!STATE.naturalCycleStates[id]) {
      const cap   = STATE.valveFlowCaps ? STATE.valveFlowCaps[id] : 0.2 + Math.random() * 0.3;
      const openMs = (cap / FLOW_RATE_LPS) * 1000;
      STATE.naturalCycleStates[id] = { phase: 'open', nextSwitch: now + openMs };
    }
    const s = STATE.naturalCycleStates[id];
    if (now >= s.nextSwitch) {
      if (s.phase === 'open') {
        // valve has been open long enough — close it for a random pause
        s.phase = 'closed';
        s.nextSwitch = now + RANDOM_MIN_MS + Math.random() * (RANDOM_MAX_MS - RANDOM_MIN_MS);
      } else {
        // close period done — generate a new random cap and reopen
        s.phase = 'open';
        const newCap = 0.2 + Math.random() * 0.3;
        STATE.valveFlowCaps[id] = newCap;
        s.nextSwitch = now + (newCap / FLOW_RATE_LPS) * 1000;
      }
    }
  });
}

// GAS LOOP
// The gasLoopTick function is called on a regular interval defined by OPEN_TIME_MS when the system is running.
// It calculates the flow increments for each open valve based on the FLOW_RATE_LPS and the time the valves have been open, while also checking against
// -> any flow limits set for the valves.
// It updates the total flow and the history, publishes the flow increments and states to MQTT, and pushes the updated state to the renderer.
function generateRandomValveCaps() {
  const caps = new Array(VALVE_COUNT + 1).fill(null);
  for (let i = 1; i <= VALVE_COUNT; i++) { // generate random caps between 0.2 and 0.5 liters for each valve, which will be used in the natural random caps mode to limit the cumulative flow for each valve
    caps[i] = 0.2 + Math.random() * 0.3; // 2–5 dL per valve (e.g. 0.24, 0.46)
  }
  return caps;
}

// This function is the main loop that runs at regular intervals to update the flow state of the system. It first checks if the system is running, and if not, it returns early. 
// Then it initializes arrays to track the flow increments for each valve and the new states of the valves. 
// It determines which valves are currently open based on the active_ids and random mode, and then calculates the flow increment for each open valve while checking against any flow limits. 
// If a valve hits its flow limit, it is closed and added to the limitedValves set. 
// Finally, it updates the total flow, history, publishes the new state to MQTT, and pushes the updated state to the renderer.
function gasLoopTick() {
  if (!STATE.running) return;
  // We get the current time to use for calculating flow increments and managing random state toggling. 
  // We also initialize arrays to track the flow increments for each valve and the new states of the valves after this tick.
  const now       = Date.now();
  const flowInc   = new Array(VALVE_COUNT + 1).fill(0.0);
  const newStates = new Array(VALVE_COUNT + 1).fill(false);
  // Determine which valves are currently open based on the active mode.
  let openIds;
  if (STATE.randomCaps) {
    // Natural cycle mode: timing-based open/close like the Python system
    tickNaturalCycleStates(now);
    openIds = STATE.active_ids.filter(id => STATE.naturalCycleStates[id]?.phase === 'open');
  } else if (STATE.random) {
    tickRandomStates(now);
    openIds = STATE.active_ids.filter(id => STATE.randomStates[id]?.open);
  } else {
    openIds = STATE.active_ids;
  }
  // We loop through the currently open valves and calculate the flow increment for each based on the defined flow rate and the time step.
  for (const vid of openIds) {
    const increment = FLOW_RATE_LPS * (OPEN_TIME_MS / 1000);

    if (STATE.randomCaps) {
      // Natural cycle mode: timing controls open/close, just track accumulated flow
      STATE.valveFlowAccum[vid] = (STATE.valveFlowAccum[vid] || 0) + increment;
      flowInc[vid]      = increment;
      STATE.flow_total += increment;
      newStates[vid]    = true;
    } else {
      const perValveLimit  = STATE.valveFlowCaps ? STATE.valveFlowCaps[vid] : null;
      const effectiveLimit = perValveLimit !== null ? perValveLimit : STATE.valveFlowLimit;
      // If there is a flow limit (either global or per-valve), we check if adding the full increment would exceed the limit. If it does,
      // -> we calculate the partial increment that would reach the limit, update the accumulated flow to the limit, and mark the valve as closed for
      // -> the next state. We also add the partial increment to the total flow if it's greater than 0. If we haven't hit the limit,
      // we simply update the accumulated flow for this valve.
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
  }
  // Update the global valve states based on the new calculations
  STATE.valve_states = newStates;
  // Record the flow history for graphing, keeping only the last 60 entries (e.g., last 5 minutes if OPEN_TIME_MS is 500ms)
  STATE.flow_history.push({ time: now, value: STATE.flow_total });
  if (STATE.flow_history.length > 60) STATE.flow_history.shift();

  publishFlow(flowInc);
  publishState(newStates);
  pushStateToRenderer();
}
// This function is responsible for sending the updated state of the system to the renderer process. It checks if the mainWindow is available and not destroyed,
// -> and if so, it sends a "state-update" message with the current state of the system, including whether it's running, which valves are active, the total flow,
// -> flow history, valve states, any limited valves, CAN connection status, and random caps status. It also allows for extra data to be included in the message if needed.
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

// IPC HANDLERS
// These handlers respond to messages from the renderer process to get the current state, start/stop the system, set active valves, 
// -> configure duration and random mode, and export CSV data.
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

// This handler starts the system by setting the running state to true, initializing random states if random mode is enabled, and setting up an auto-stop
// -> timer if a duration is specified.
ipcMain.handle("api:start", () => {
  STATE.running = true;
  // If random mode is enabled, we initialize the random states for the active valves to start the random toggling behavior.
  if (STATE.random)      initRandomStates();
  if (STATE.randomCaps)  initNaturalCycleStates();
  // If there is an existing auto-stop timer, we clear it to avoid multiple timers running simultaneously. 
  // Then, if a duration is specified in the state, we set up a new auto-stop timer that will stop the system after the specified duration has elapsed. 
  // When the timer triggers, it sets the running state to false, resets the valve states, sends all valves closed to the CAN bus, pushes an update
  // -> to the renderer indicating that the system was auto-stopped, and logs a message with the duration.
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  if (STATE.duration) { // Set up auto-stop timer if duration is specified
    autoStopTimer = setTimeout(() => {
      STATE.running      = false;
      STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
      autoStopTimer      = null;
      sendAllClosed();
      pushStateToRenderer({ auto_stopped: true });
      console.log("[SYSTEM] Auto-stopped after", STATE.duration, "ms");
    }, STATE.duration);
  }
  // If the gas loop timer is not already running, we start it to begin processing the flow updates at regular intervals defined by OPEN_TIME_MS.
  if (!gasLoopTimer) gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
  console.log("[SYSTEM] Started — duration:", STATE.duration, "random:", STATE.random);
  return { status: "started" };
});

// This handler stops the system by setting the running state to false, resetting the valve states, clearing any existing auto-stop timer, 
// sending all valves closed to the CAN bus, and pushing an update to the renderer. It also logs a message indicating that the system has been stopped. 
ipcMain.handle("api:stop", () => {
  STATE.running      = false;
  STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } // Clear any existing auto-stop timer to prevent it from triggering after we've manually stopped the system
  sendAllClosed();
  pushStateToRenderer();
  console.log("[SYSTEM] Stopped");
  return { status: "stopped" };
});

// This handler performs an emergency stop by immediately stopping the system, resetting all states, clearing timers, sending all valves closed, 
// -> and pushing an update to the renderer.
ipcMain.handle("api:emergency", () => {
  STATE.running      = false;
  STATE.active_ids   = [];
  STATE.valve_states = new Array(VALVE_COUNT + 1).fill(false);
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; } // Clear any existing auto-stop timer to prevent it from triggering after the emergency stop
  sendAllClosed();
  pushStateToRenderer();
  console.log("[SYSTEM] *** EMERGENCY STOP ***");
  return { status: "EMERGENCY STOP" };
});

// This handler updates the active valve IDs based on the input from the renderer. It also resets the flow accumulation for any valves that are being re-activated after being capped,
ipcMain.handle("api:valves", (_event, { active_ids }) => {
  const incoming = new Set(active_ids || []);
  // Re-activating a previously capped valve resets its counter
  for (const id of incoming) {
    // If the incoming set of active IDs includes a valve ID that is currently in the limitedValves set (indicating it has hit its flow limit), we remove it from the limitedValves set 
    //  -> and reset its accumulated flow to 0. This allows the valve to be re-activated with a fresh state, rather than being stuck in a limited state due to previous usage.
    if (STATE.limitedValves.has(id)) { // Check if the valve ID is in the limitedValves set
      STATE.limitedValves.delete(id);
      STATE.valveFlowAccum[id] = 0.0;
    }
  }
  // Update the active_ids in the state with the new set of active valve IDs. If random mode is enabled and the system is running, 
  // -> we also re-initialize the random states to reflect any changes in the active valves.
  STATE.active_ids = Array.from(incoming); // Ensure it's an array
  if (STATE.random && STATE.running) initRandomStates();
  console.log("[VALVES] Active IDs:", STATE.active_ids);
  return { status: "ok", active_ids: STATE.active_ids };
});

// This handler sets the duration for how long the system should run before automatically stopping. It updates the duration in the state and logs the new duration.
ipcMain.handle("api:set_duration", (_event, { duration }) => {
  STATE.duration = duration || null; // Ensure that if duration is falsy (e.g., 0, undefined), we set it to null to indicate no auto-stop
  console.log("[DURATION] Set to:", STATE.duration);
  return { status: "ok", duration: STATE.duration };
});

// This handler toggles the random mode on or off based on the input from the renderer. It updates the random flag in the state, initializes random states if necessary, and logs the new mode.
ipcMain.handle("api:set_random", (_event, { enabled }) => {
  STATE.random = !!enabled; // Ensure it's a boolean value
  if (STATE.random && STATE.running) initRandomStates();
  console.log("[RANDOM] Mode:", STATE.random);
  return { status: "ok", random: STATE.random };
});

// This handler toggles the random caps mode on or off. When enabled, it generates random flow caps for each valve and updates the state accordingly. 
// When disabled, it clears the caps. It also logs the new mode and pushes the updated state to the renderer.
ipcMain.handle("api:set_random_caps", () => {
  STATE.randomCaps = !STATE.randomCaps;
  if (STATE.randomCaps) { // Enabling natural mode: generate random caps and initialise per-valve cycle timing.
    STATE.valveFlowCaps = generateRandomValveCaps();
    STATE.active_ids    = Array.from({ length: VALVE_COUNT }, (_, i) => i + 1);
    STATE.valve_states  = new Array(VALVE_COUNT + 1).fill(true);
    if (STATE.running) initNaturalCycleStates();
    console.log("[NATURAL] Enabled — valves cycle with random open durations (2–5 dL) and random close pauses");
  } else { // Disabling random caps mode clears the per-valve caps and allows all valves to operate without individual limits, relying only on any global flow limit if set.
    STATE.valveFlowCaps = null;
    console.log("[RANDOM CAPS] Disabled");
  } // Whenever we toggle the random caps mode, we also want to push the updated state to the renderer so that it can reflect the new caps and any changes in valve states.
  pushStateToRenderer();
  return { status: "ok", random_caps: STATE.randomCaps };
});

// This handler sets a global flow limit for the valves. It updates the valveFlowLimit in the state based on the input, ensuring that it is either a positive number or null 
// (indicating no limit). It logs the new flow limit and returns the updated limit in the response.
ipcMain.handle("api:set_flow_limit", (_event, { limit }) => {
  STATE.valveFlowLimit = (limit && limit > 0) ? limit : null;
  console.log("[FLOW LIMIT] Set to:", STATE.valveFlowLimit, "L");
  return { status: "ok", limit: STATE.valveFlowLimit };
});

// This handler resets the total flow and flow history, clears the accumulated flow for each valve, and clears the set of limited valves. 
// This can be used to start fresh without restarting the entire system. It logs that the totals have been reset and returns a status message.
ipcMain.handle("api:reset_total", () => {
  STATE.flow_total     = 0.0;
  STATE.flow_history   = [];
  STATE.valveFlowAccum = new Array(VALVE_COUNT + 1).fill(0.0);
  STATE.limitedValves  = new Set();
  return { status: "reset" };
});

// This handler exports the flow history data to a CSV file on the user's desktop. It constructs a filename with a timestamp, creates the CSV content with headers and flow data,
// and writes it to the desktop. It returns the path to the saved file or an error message if something goes wrong.
ipcMain.handle("api:csv", () => {
  try { // Generate a filename with a timestamp to ensure uniqueness and indicate when the data was exported
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename  = `meqal_flow_${timestamp}.csv`;
    const desktop   = require("os").homedir() + "/Desktop/" + filename;

    const rows = ["timestamp,flow_total,active_valve_count"];
    for (const h of STATE.flow_history) { // For each entry in the flow history, we create a CSV row with the timestamp (in ISO format), the total flow value 
    // -> (formatted to 4 decimal places), and the count of active valves at that time. We push these rows into the rows array.
      rows.push(`${new Date(h.time).toISOString()},${h.value.toFixed(4)},${STATE.active_ids.length}`);
    }
    // Write the CSV content to the desktop file. We join the rows with newline characters to create the final CSV string. If the write is successful, 
    // -> we log a message and return the path to the saved file. If there is an error during writing, we catch it, log an error message, and return an error status.
    fs.writeFileSync(desktop, rows.join("\n"));
    console.log("[CSV] Saved to", desktop);
    return { status: "ok", path: desktop };
  } catch (e) { // If any error occurs during the CSV generation or file writing process, we catch it and log an error message with the details of the exception. 
    // We also return an error status with the message to inform the renderer of the failure.
    console.error("[CSV] Error:", e.message);
    return { status: "error", message: e.message };
  }
});

// CREATE WINDOW
// This function creates the main application window using Electron's BrowserWindow. It sets the dimensions, background color, title bar style, and web preferences for security.
// It loads the index.html file from the renderer directory and opens the developer tools if in development mode. It also sets up an event listener to handle when the window is closed.
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
// Load the index.html file from the renderer directory to display the user interface. We use path.join to construct the correct path to the HTML file based on the current directory.
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  if (process.env.NODE_ENV === "development") mainWindow.webContents.openDevTools();
  mainWindow.on("closed", () => { mainWindow = null; });
}

// APP LIFECYCLE
// When the Electron app is ready, we set up the MQTT connection, initialize the CAN bus, create the main application window, and start the gas loop timer to begin processing flow updates.
app.whenReady().then(() => {
  setupMqtt();
  setupCan();
  createWindow();
  gasLoopTimer = setInterval(gasLoopTick, OPEN_TIME_MS);
});

// When all windows are closed, we clear any running timers, send a command to close all valves, end the MQTT connection if it exists, and quit the application.
app.on("window-all-closed", () => {
  if (gasLoopTimer)    clearInterval(gasLoopTimer); // Clear the gas loop timer to stop processing flow updates
  if (canRefreshTimer) clearInterval(canRefreshTimer); // Clear the CAN refresh timer to stop sending PDOs to the CAN bus
  if (autoStopTimer)   clearTimeout(autoStopTimer); // Clear the auto-stop timer to prevent it from triggering after the windows are closed
  sendAllClosed(); // Send a command to the CAN bus to set all valves to the closed state, ensuring that the system is left in a safe state when the application is closed
  if (mqttClient) mqttClient.end(); // End the MQTT connection gracefully if it was established
  app.quit(); // Quit the Electron application, which will close all windows and exit the process
});

// This event listener handles the "activate" event, which is emitted when the user clicks the app's icon in the dock or reopens the app. 
// If there are no open windows at that time, we call createWindow() to open a new main window.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
