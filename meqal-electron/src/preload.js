// =====================================================
// MEQAL PRELOAD — IPC BRIDGE
// Exposes a safe window.api object to the renderer
// Replaces Flask fetch() calls with Electron IPC
// =====================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {

  // Mirrors GET /api/state
  getState: () => ipcRenderer.invoke("api:state"),

  // Mirrors POST /api/start
  start: () => ipcRenderer.invoke("api:start"),

  // Mirrors POST /api/stop
  stop: () => ipcRenderer.invoke("api:stop"),

  // Mirrors POST /api/emergency
  emergency: () => ipcRenderer.invoke("api:emergency"),

  // Mirrors POST /api/valves  { active_ids: [...] }
  setValves: (activeIds) => ipcRenderer.invoke("api:valves", { active_ids: activeIds }),

  // Mirrors POST /api/set_duration  { duration: ms | null }
  setDuration: (ms) => ipcRenderer.invoke("api:set_duration", { duration: ms }),

  // Mirrors POST /api/set_random  { enabled: bool }
  setRandom: (enabled) => ipcRenderer.invoke("api:set_random", { enabled }),
  setRandomCaps: () => ipcRenderer.invoke("api:set_random_caps"),

  // Set per-valve cumulative flow cap (L); pass null to disable
  setFlowLimit: (limitL) => ipcRenderer.invoke("api:set_flow_limit", { limit: limitL }),

  // Mirrors POST /api/reset_total
  resetTotal: () => ipcRenderer.invoke("api:reset_total"),

  // Mirrors POST /api/csv
  generateCsv: () => ipcRenderer.invoke("api:csv"),

  // Listen for live push updates from main process
  onStateUpdate: (callback) => {
    ipcRenderer.on("state-update", (_event, data) => callback(data));
  },

  // Remove all state-update listeners (cleanup)
  offStateUpdate: () => {
    ipcRenderer.removeAllListeners("state-update");
  },
});
