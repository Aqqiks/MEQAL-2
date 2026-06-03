
// MEQAL PRELOAD — IPC BRIDGE
// This preload script runs in a sandboxed context between the main and renderer processes.
// It exposes a safe window.api object to the renderer by using contextBridge, bridging IPC calls
// -> to the main process without granting full Node.js access to the renderer.

const { contextBridge, ipcRenderer } = require("electron");


// CONTEXT BRIDGE
// Exposes a window.api object to the renderer with named methods that invoke IPC channels.
// Each method maps to a corresponding ipcMain.handle() registered in main.js.
contextBridge.exposeInMainWorld("api", {

  // Fetch the current system state from the main process (valve states, flow totals, running flag, etc.)
  getState: () => ipcRenderer.invoke("api:state"),

  // Start the valve control system, beginning the gas loop and CAN bus PDO output
  start: () => ipcRenderer.invoke("api:start"),

  // Stop the system gracefully, resetting valve states and halting gas loop updates
  stop: () => ipcRenderer.invoke("api:stop"),

  // Perform an emergency stop — immediately clears all active valve IDs and sends closed PDOs
  emergency: () => ipcRenderer.invoke("api:emergency"),

  // Update the set of active valve IDs; pass a 1-indexed array of valve numbers to open
  setValves: (activeIds) => ipcRenderer.invoke("api:valves", { active_ids: activeIds }),

  // Set the auto-stop duration in milliseconds; pass null to disable the timer and run until manually stopped
  setDuration: (ms) => ipcRenderer.invoke("api:set_duration", { duration: ms }),

  // Toggle random mode on or off; when enabled, active valves cycle open/closed at random intervals
  setRandom: (enabled) => ipcRenderer.invoke("api:set_random", { enabled }),

  // Toggle the natural random caps mode, which assigns each valve a random 2–5 dL cumulative flow cap
  setRandomCaps: () => ipcRenderer.invoke("api:set_random_caps"),

  // Set a global per-valve cumulative flow cap in litres; pass null to disable the limit
  setFlowLimit: (limitL) => ipcRenderer.invoke("api:set_flow_limit", { limit: limitL }),

  // Reset the total flow counter, flow history, per-valve accumulators, and the limited valve set
  resetTotal: () => ipcRenderer.invoke("api:reset_total"),

  // Export the current flow history to a timestamped CSV file on the user's desktop
  generateCsv: () => ipcRenderer.invoke("api:csv"),

  // Register a callback to receive live state-update pushes from the main process
  // -> The callback is called with the latest system state object whenever the main process sends an update
  onStateUpdate: (callback) => {
    ipcRenderer.on("state-update", (_event, data) => callback(data));
  },

  // Remove all registered state-update listeners, used for cleanup when the renderer is torn down
  offStateUpdate: () => {
    ipcRenderer.removeAllListeners("state-update");
  },
});
