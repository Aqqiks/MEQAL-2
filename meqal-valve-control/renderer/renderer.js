// ============================================================================
// MEQAL FRONTEND CONTROLLER — RENDERER
// ----------------------------------------------------------------------------
// Drives the UI: 7x7 valve grid, toolbar controls, charts, and live state from
// the main process. The renderer holds NO physics — it sends intent and renders
// whatever the main process pushes back.
//
// Robustness: every control and the IPC listener are wired up BEFORE charts are
// created, and chart creation is guarded. If Chart.js fails to load (offline,
// CDN/CSP), the control surface still works completely — only the graphs go
// dark. This is deliberate: a control panel must never be bricked by a chart.
// ============================================================================

const GRID_SIZE        = 7;
const VALVE_COUNT      = 49;

// --- Local UI state ----------------------------------------------------------
let activeValves   = new Set();
let isRunning      = false;
let currentMode    = "continuous";   // "continuous" | "random" | "natural"

// --- Element handles ----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const totalText   = $("totalText");
const activeCount = $("activeCount");
const flowRateEl  = $("flowRate");
const sysStatus   = $("sysStatus");
const pulseDot    = $("pulseDot");
const sbStatus    = $("sbStatus");
const sbTime      = $("sbTime");
const canStatus   = $("canStatus");
const canDot      = $("canDot");
const normalBtn   = $("normalBtn");
const randomBtn   = $("randomBtn");
const naturalBtn  = $("randomCapsBtn");

// ============================================================================
// TOAST
// ============================================================================
let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("toast");
  if (!el) return;
  el.textContent       = msg;
  el.style.borderColor = isError ? "var(--red)" : "var(--border-hi)";
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

// ============================================================================
// VALVE GRID — 7x7 clickable map
// ============================================================================
const valveGrid = $("valveGrid");
for (let i = 1; i <= VALVE_COUNT; i++) {
  const box = document.createElement("div");
  box.className = "box";
  box.id        = `valve-${i}`;
  box.innerText = i;
  box.onclick   = () => {
    if (activeValves.has(i)) {
      activeValves.delete(i);
      box.classList.remove("online");
    } else {
      activeValves.add(i);
      box.classList.remove("done", "offline");
      box.classList.add("online");
    }
    syncValves();
  };
  valveGrid.appendChild(box);
}

// Send the current selection to the main process.
async function syncValves() {
  await window.api.setValves(Array.from(activeValves));
  activeCount.innerText = activeValves.size;
}

// ============================================================================
// CONTROL WIRING  (done first, so the panel is never dead)
// ============================================================================

// Start: opens the selected valves (or all 49 if none are selected) and runs
// in the current mode until the cap, Stop, or Emergency Stop. Start and Stop
// are distinct buttons — no fragile double-press gesture.
$("startBtn").addEventListener("click", async () => {
  await window.api.start();
  toast(isRunning ? "Already running" : "System started");
});

$("stopBtn").addEventListener("click", async () => {
  await window.api.stop();
  toast("System stopped");
});

$("emergencyBtn").addEventListener("click", async () => {
  await window.api.emergency();
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => {
    b.classList.remove("online", "done");
    b.classList.add("offline");
  });
  document.body.classList.add("emergency");
  setTimeout(() => document.body.classList.remove("emergency"), 1200);
  toast("\u26A0 EMERGENCY STOP — all valves closed", true);
});

$("selectAllBtn").addEventListener("click", async () => {
  activeValves = new Set(Array.from({ length: VALVE_COUNT }, (_, i) => i + 1));
  document.querySelectorAll(".box").forEach(b => {
    b.classList.remove("offline", "done");
    b.classList.add("online");
  });
  await syncValves();
  toast("All 49 valves selected");
});

$("areaSelect").onchange = async (e) => {
  const val = e.target.value;
  if (!val) return;
  activeValves.clear();
  if (val.startsWith("row-")) {
    const row   = parseInt(val.slice(4), 10);
    const start = (row - 1) * GRID_SIZE + 1;
    for (let i = start; i < start + GRID_SIZE; i++) activeValves.add(i);
    toast(`Row ${row} selected (valves ${start}\u2013${start + GRID_SIZE - 1})`);
  } else if (val.startsWith("col-")) {
    const col = parseInt(val.slice(4), 10);
    for (let r = 0; r < GRID_SIZE; r++) activeValves.add(col + r * GRID_SIZE);
    toast(`Col ${col} selected`);
  }
  document.querySelectorAll(".box").forEach((b, i) => {
    b.classList.toggle("online", activeValves.has(i + 1));
    b.classList.remove("offline", "done");
  });
  await syncValves();
};

$("timeSelect").addEventListener("change", async (e) => {
  const ms = parseInt(e.target.value, 10) || null;
  await window.api.setDuration(ms);
  toast(ms ? `Timer: ${e.target.options[e.target.selectedIndex].text}` : "Timer off — runs until stop");
});

// Mode selection. The three modes are mutually exclusive. Pressing the active
// Random/Natural button returns to continuous (normal).
async function setMode(mode) {
  const res = await window.api.setMode(mode);
  currentMode = res.mode || mode;
  reflectMode();
}
function reflectMode() {
  normalBtn.classList.toggle("btn-normal-on",  currentMode === "continuous");
  randomBtn.classList.toggle("btn-random-on",  currentMode === "random");
  naturalBtn.classList.toggle("btn-random-on", currentMode === "natural");
}

// Normal: select every valve and run continuously. Opens all valves and keeps
// releasing gas until the per-valve cap, Stop, or Emergency Stop.
normalBtn.addEventListener("click", async () => {
  activeValves = new Set(Array.from({ length: VALVE_COUNT }, (_, i) => i + 1));
  document.querySelectorAll(".box").forEach(b => {
    b.classList.remove("offline", "done");
    b.classList.add("online");
  });
  await syncValves();
  await setMode("continuous");
  toast("Normal mode \u2014 all 49 valves open, flowing until cap/stop");
});

// Random / Natural toggle: pressing the active one drops back to continuous.
randomBtn.addEventListener("click", async () => {
  const next = currentMode === "random" ? "continuous" : "random";
  await setMode(next);
  toast(next === "random"
    ? "Random mode \u2014 valves cycle at random intervals"
    : "Continuous mode \u2014 selected valves stay open");
});
naturalBtn.addEventListener("click", async () => {
  const next = currentMode === "natural" ? "continuous" : "natural";
  await setMode(next);
  toast(next === "natural"
    ? "Natural mode \u2014 each valve pulses its own random 2\u20135 dL bursts"
    : "Continuous mode \u2014 selected valves stay open");
});

// Cumulative per-valve cap, typed in decilitres, sent as litres.
$("flowCapInput").addEventListener("change", async (e) => {
  const dl     = parseFloat(e.target.value);
  const limitL = (dl > 0) ? dl * 0.1 : null;
  await window.api.setFlowLimit(limitL);
  toast(limitL ? `Cumulative cap: ${dl} dL/valve` : "Flow cap disabled");
});

$("resetValvesBtn").addEventListener("click", async () => {
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => b.classList.remove("online", "offline", "done"));
  await syncValves();
  toast("Valve selection cleared");
});

$("resetTotalBtn").addEventListener("click", async () => {
  await window.api.resetTotal();
  totalText.innerText = "0.00";
  lastFlowTotal = 0;
  resetCharts();
  document.querySelectorAll(".box.done").forEach(b => b.classList.remove("done"));
  toast("Total flow reset");
});

$("resetCapsBtn").addEventListener("click", async () => {
  await window.api.resetCaps();
  valveCumulativeFlow.fill(0);
  pushBarChart();
  document.querySelectorAll(".box.done").forEach(b => b.classList.remove("done"));
  const capInput = $("flowCapInput");
  if (capInput) capInput.value = "";
  toast("Valve caps reset");
});

$("csvBtn").addEventListener("click", async () => {
  const result = await window.api.generateCsv();
  if (result.status === "ok") toast(`CSV saved: ${result.path}`);
  else toast(`CSV error: ${result.message}`, true);
});

// Clock.
function updateClock() { sbTime.textContent = new Date().toLocaleTimeString(); }
setInterval(updateClock, 1000);
updateClock();

// ============================================================================
// CHARTS  (guarded — failure here must not break the controls above)
// ============================================================================
const valveLabels         = Array.from({ length: VALVE_COUNT }, (_, i) => `V${i + 1}`);
const valveCumulativeFlow = new Array(VALVE_COUNT).fill(0); // litres, mirrors backend
let lastFlowTotal = 0;

let valveChart = null, mainChart = null, miniChart = null;
let valveChartData, chartData, miniData;

function makeNoopChart() { return { update() {}, data: {} }; }

function initCharts() {
  if (typeof Chart === "undefined") {
    console.warn("[UI] Chart.js unavailable — charts disabled, controls unaffected.");
    valveChart = mainChart = miniChart = makeNoopChart();
    document.querySelectorAll(".chart-wrap, .valve-chart-wrap, .mini-chart-wrap")
      .forEach(el => { el.style.opacity = 0.35; });
    return;
  }
  try {
    const mono = { family: "JetBrains Mono", size: 9 };
    const tip  = {
      backgroundColor: "#0e1318", borderColor: "#1e2d3d", borderWidth: 1,
      titleColor: "#7a8fa8", bodyColor: "#e2eaf4", bodyFont: { family: "JetBrains Mono", size: 12 },
    };

    // Per-valve cumulative flow (bar) — shown in dL.
    valveChartData = {
      labels: valveLabels,
      datasets: [{
        label: "Cumulative Flow (dL)", data: [...valveCumulativeFlow],
        backgroundColor: "rgba(34,197,94,0.45)", borderColor: "#22c55e", borderWidth: 1,
      }],
    };
    valveChart = new Chart($("valveChartCanvas").getContext("2d"), {
      type: "bar", data: valveChartData,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: (c) => ((c.parsed.y || 0) * 10).toFixed(3) + " dL" } } },
        scales: {
          x: { ticks: { color: "#3d5268", font: mono, autoSkip: false, maxRotation: 90, minRotation: 90 }, grid: { color: "rgba(30,45,61,0.6)" } },
          y: { ticks: { color: "#3d5268", font: mono, callback: (v) => (v * 10).toFixed(2) }, grid: { color: "rgba(30,45,61,0.6)" }, beginAtZero: true },
        },
      },
    });

    // Live flow rate (line).
    chartData = {
      labels: [],
      datasets: [{
        label: "Flow Rate (L/s)", data: [],
        borderColor: "#22c55e", backgroundColor: "rgba(34,197,94,0.08)",
        borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.4,
      }],
    };
    mainChart = new Chart($("chartCanvas").getContext("2d"), {
      type: "line", data: chartData,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: (c) => (c.parsed.y || 0).toFixed(3) + " L/s" } } },
        scales: {
          x: { ticks: { color: "#3d5268", font: mono, maxTicksLimit: 8 }, grid: { color: "rgba(30,45,61,0.6)" } },
          y: { ticks: { color: "#3d5268", font: mono, callback: (v) => v.toFixed(2) }, grid: { color: "rgba(30,45,61,0.6)" }, beginAtZero: true },
        },
      },
    });

    // Cumulative total (mini sparkline).
    miniData = {
      labels: [],
      datasets: [{
        data: [], borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,0.08)",
        borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.4,
      }],
    };
    miniChart = new Chart($("totalChartCanvas").getContext("2d"), {
      type: "line", data: miniData,
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { ...tip, callbacks: { label: (c) => (c.parsed.y || 0).toFixed(3) + " L" } } },
        scales: {
          x: { display: false },
          y: { display: true, ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 8 }, maxTicksLimit: 4, callback: (v) => v.toFixed(2) }, grid: { color: "rgba(30,45,61,0.4)" }, beginAtZero: true },
        },
      },
    });
  } catch (e) {
    console.warn("[UI] Chart init failed:", e.message);
    valveChart = mainChart = miniChart = makeNoopChart();
  }
}

function pushBarChart() {
  if (!valveChartData) return;
  valveChartData.datasets[0].data = [...valveCumulativeFlow];
  valveChart.update("none");
}

function resetCharts() {
  if (chartData) { chartData.labels = []; chartData.datasets[0].data = []; mainChart.update("none"); }
  if (miniData)  { miniData.labels = [];  miniData.datasets[0].data = [];  miniChart.update("none"); }
  valveCumulativeFlow.fill(0);
  pushBarChart();
}

// ============================================================================
// RENDER STATE
// ============================================================================
function updateUi(state) {
  const total    = state.flow_total || 0;
  const actCount = (state.active_ids || []).length;
  const flowNow  = Math.max(0, (total - lastFlowTotal) * (1000 / 100)); // tick = 100ms
  lastFlowTotal  = total;

  totalText.innerText   = total.toFixed(2);
  activeCount.innerText = actCount;
  flowRateEl.innerText  = flowNow.toFixed(2);

  isRunning = state.running;
  pulseDot.classList.toggle("stopped", !isRunning);
  sysStatus.textContent = isRunning ? "RUNNING" : "IDLE";
  sbStatus.textContent  = isRunning ? `Running \u00B7 ${actCount} valves active` : "System idle";

  const connected       = !!state.can_connected;
  canDot.className      = "can-dot " + (connected ? "ok" : "err");
  canStatus.textContent = connected ? "CAN OK" : (state.can_simulated ? "CAN SIM" : "NO CAN");

  if (state.mode) { currentMode = state.mode; reflectMode(); }

  // Selection is authoritative from the backend.
  activeValves = new Set(state.active_ids || []);
  const limited = new Set(state.limited_ids || []);

  for (let i = 1; i <= VALVE_COUNT; i++) {
    const box = $(`valve-${i}`);
    if (!box) continue;
    const isSelected = activeValves.has(i);
    const isOpen     = state.valve_states ? !!state.valve_states[i] : false;
    const isLimited  = limited.has(i);
    box.classList.toggle("online", isSelected || isOpen);
    box.classList.toggle("done", isLimited && !isSelected && !isOpen);
    box.classList.remove("offline");
  }

  // Per-valve bar chart straight from the backend accumulators (no drift).
  if (state.valve_flow_accum) {
    for (let i = 1; i <= VALVE_COUNT; i++) valveCumulativeFlow[i - 1] = state.valve_flow_accum[i] || 0;
    pushBarChart();
  }

  // Flow-rate line + cumulative sparkline from history.
  if (state.flow_history && state.flow_history.length > 0 && chartData) {
    const h = state.flow_history;
    const labels = h.map(p => new Date(p.time).toLocaleTimeString());
    const rates = h.map((p, i) => {
      if (i === 0) return 0;
      const dt = (p.time - h[i - 1].time) / 1000 || 0.1;
      return Math.max(0, parseFloat(((p.value - h[i - 1].value) / dt).toFixed(3)));
    });
    chartData.labels = labels;
    chartData.datasets[0].data = rates;
    mainChart.update("none");

    miniData.labels = labels;
    miniData.datasets[0].data = h.map(p => parseFloat(p.value.toFixed(3)));
    miniChart.update("none");
  }
}

// ============================================================================
// LIVE PUSH + BOOT
// ============================================================================
window.api.onStateUpdate((state) => {
  updateUi(state);
  if (state.auto_stopped) toast("Timer elapsed — system stopped");
});

async function loadInitialState() {
  const state = await window.api.getState();
  activeValves = new Set(state.active_ids || []);
  if (state.valve_flow_limit) {
    const el = $("flowCapInput");
    if (el) el.value = (state.valve_flow_limit * 10).toFixed(1);
  }
  if (state.mode) { currentMode = state.mode; reflectMode(); }
  updateUi(state);
}

// Charts last; if they throw, the controls above are already live.
initCharts();
loadInitialState();
