// ============================================================================
// MEQAL PRELOAD — IPC BRIDGE
// ----------------------------------------------------------------------------
// Runs in an isolated context between main and renderer. Exposes a minimal,
// explicit window.api surface; the renderer gets no direct Node/IPC access.
// Every method maps 1:1 to an ipcMain.handle() in main.js.
// ============================================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Full current system state (used on load / reload).
  getState: () => ipcRenderer.invoke("api:state"),

  // Run control.
  start:     () => ipcRenderer.invoke("api:start"),
  stop:      () => ipcRenderer.invoke("api:stop"),
  emergency: () => ipcRenderer.invoke("api:emergency"),

  // Selection: pass a 1-indexed array of valve IDs to keep open/active.
  setValves: (activeIds) => ipcRenderer.invoke("api:valves", { active_ids: activeIds }),

  // Auto-stop duration in ms; null/0 = run until manually stopped.
  setDuration: (ms) => ipcRenderer.invoke("api:set_duration", { duration: ms }),

  // Run mode: "continuous" | "random" | "natural".
  setMode: (mode) => ipcRenderer.invoke("api:set_mode", { mode }),

  // Cumulative per-valve safety cap in litres; null/0 = no cap.
  setFlowLimit: (limitL) => ipcRenderer.invoke("api:set_flow_limit", { limit: limitL }),

  // Resets.
  resetTotal: () => ipcRenderer.invoke("api:reset_total"),
  resetCaps:  () => ipcRenderer.invoke("api:reset_caps"),

  // Export flow history to a timestamped CSV on the desktop.
  generateCsv: () => ipcRenderer.invoke("api:csv"),

  // Live state pushes from the main process.
  onStateUpdate: (callback) => {
    ipcRenderer.on("state-update", (_event, data) => callback(data));
  },
  offStateUpdate: () => {
    ipcRenderer.removeAllListeners("state-update");
  },
});
