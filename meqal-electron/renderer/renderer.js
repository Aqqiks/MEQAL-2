// =====================================================
// MEQAL FRONTEND CONTROLLER — ELECTRON VERSION
// Uses window.api (IPC) instead of fetch()
// =====================================================

const GRID_SIZE = 7;
const VALVE_COUNT = 49;
const MAX_CHART_POINTS = 60;

// =====================================================
// STATE
// =====================================================

let activeValves = new Set();
let isRunning = false;

// =====================================================
// ELEMENTS
// =====================================================

const totalText    = document.getElementById("totalText");
const activeCount  = document.getElementById("activeCount");
const flowRateEl   = document.getElementById("flowRate");
const sysStatus    = document.getElementById("sysStatus");
const pulseDot     = document.getElementById("pulseDot");
const sbStatus     = document.getElementById("sbStatus");
const sbTime       = document.getElementById("sbTime");
const canStatus    = document.getElementById("canStatus");
const canDot       = document.getElementById("canDot");

// =====================================================
// BUILD VALVE GRID (7×7 = 49 boxes)
// =====================================================

const valveGrid = document.getElementById("valveGrid");

for (let i = 1; i <= VALVE_COUNT; i++) {
  const box = document.createElement("div");
  box.className = "box";
  box.id = `valve-${i}`;
  box.innerText = i;

  box.onclick = () => {
    if (activeValves.has(i)) {
      activeValves.delete(i);
      box.classList.remove("online");
    } else {
      activeValves.add(i);
      box.classList.remove("done");
      box.classList.add("online");
    }
    syncValves();
  };

  valveGrid.appendChild(box);
}

// =====================================================
// PER-VALVE CUMULATIVE FLOW BAR CHART
// =====================================================

const valveLabels = Array.from({ length: VALVE_COUNT }, (_, i) => `V${i + 1}`);
const valveCumulativeFlow = new Array(VALVE_COUNT).fill(0);

const valveChartCtx = document.getElementById("valveChartCanvas").getContext("2d");

const valveChartData = {
  labels: valveLabels,
  datasets: [{
    label: "Cumulative Flow (L)",
    data: [...valveCumulativeFlow],
    backgroundColor: "rgba(34,197,94,0.45)",
    borderColor: "#22c55e",
    borderWidth: 1,
  }]
};

const valveChart = new Chart(valveChartCtx, {
  type: "bar",
  data: valveChartData,
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0e1318",
        borderColor: "#1e2d3d",
        borderWidth: 1,
        titleColor: "#7a8fa8",
        bodyColor: "#e2eaf4",
        bodyFont: { family: "JetBrains Mono", size: 12 },
      }
    },
    scales: {
      x: {
        ticks: {
          color: "#3d5268",
          font: { family: "JetBrains Mono", size: 9 },
          autoSkip: false,
          maxRotation: 90,
          minRotation: 90,
        },
        grid: { color: "rgba(30,45,61,0.6)" },
      },
      y: {
        ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 9 } },
        grid: { color: "rgba(30,45,61,0.6)" },
        beginAtZero: true,
      }
    }
  }
});

// =====================================================
// MAIN FLOW CHART
// =====================================================

const chartCtx = document.getElementById("chartCanvas").getContext("2d");

const chartData = {
  labels: [],
  datasets: [{
    label: "Flow Rate (L/s)",
    data: [],
    borderColor: "#22c55e",
    backgroundColor: "rgba(34,197,94,0.08)",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: true,
    tension: 0.4,
  }]
};

const mainChart = new Chart(chartCtx, {
  type: "line",
  data: chartData,
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0e1318",
        borderColor: "#1e2d3d",
        borderWidth: 1,
        titleColor: "#7a8fa8",
        bodyColor: "#e2eaf4",
        bodyFont: { family: "JetBrains Mono", size: 12 },
      }
    },
    scales: {
      x: {
        ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 8 },
        grid:  { color: "rgba(30,45,61,0.6)" },
      },
      y: {
        ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 9 } },
        grid:  { color: "rgba(30,45,61,0.6)" },
        beginAtZero: true,
      }
    }
  }
});


// =====================================================
// MINI FLOW HISTORY CHART
// =====================================================

const miniCtx = document.getElementById("totalChartCanvas").getContext("2d");

const miniData = {
  labels: [],
  datasets: [{
    data: [],
    borderColor: "#3b82f6",
    backgroundColor: "rgba(59,130,246,0.08)",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: true,
    tension: 0.4,
  }]
};

const miniChart = new Chart(miniCtx, {
  type: "line",
  data: miniData,
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: {
        display: true,
        ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 8 }, maxTicksLimit: 4 },
        grid:  { color: "rgba(30,45,61,0.4)" },
        beginAtZero: true,
      }
    }
  }
});

// =====================================================
// UPDATE UI FROM STATE
// =====================================================

let lastFlowTotal = 0;

function updateUi(state) {

  const total    = state.flow_total || 0;
  const actCount = (state.active_ids || []).length;
  const flowNow  = (total - lastFlowTotal) * 2; // per-second estimate (tick = 0.5s)
  lastFlowTotal  = total;

  // Totals
  totalText.innerText  = total.toFixed(2);
  activeCount.innerText = actCount;
  flowRateEl.innerText  = flowNow.toFixed(2);

  // Running state styling
  isRunning = state.running;
  pulseDot.classList.toggle("stopped", !isRunning);
  sysStatus.textContent = isRunning ? "RUNNING" : "IDLE";
  sbStatus.textContent  = isRunning
    ? `Running · ${actCount} valves active`
    : "System idle";

  // CAN connection badge
  const connected = !!state.can_connected;
  canDot.className = "can-dot " + (connected ? "ok" : "err");
  canStatus.textContent = connected ? "CAN OK" : "NO CAN";

  // Random cap mode badge
  const capsOn = !!state.random_caps;
  randomCapsMode = capsOn;
  randomCapsBtn.classList.toggle("btn-random-on", capsOn);

  // Update valve grid visuals from backend state
  if (state.valve_states) {
    for (let i = 1; i <= VALVE_COUNT; i++) {
      const box = document.getElementById(`valve-${i}`);
      if (box) box.classList.toggle("online", state.valve_states[i]);
    }
  }

  // Mark capped valves as "done" in the grid
  if (state.limited_ids) {
    for (const vid of state.limited_ids) {
      activeValves.delete(vid);
      const box = document.getElementById(`valve-${vid}`);
      if (box && !box.classList.contains("online")) box.classList.add("done");
    }
  }

  // Per-valve cumulative flow accumulation (0.5 s tick)
  if (state.valve_states && state.running) {
    const tickFlow = FLOW_RATE_LPS_PER_VALVE * 0.5;
    for (let i = 1; i <= VALVE_COUNT; i++) {
      if (state.valve_states[i]) valveCumulativeFlow[i - 1] += tickFlow;
    }
    valveChartData.datasets[0].data = [...valveCumulativeFlow];
    valveChart.update("none");
  }

  // Append to main chart
  if (state.flow_history && state.flow_history.length > 0) {
    const history = state.flow_history;

    chartData.labels   = history.map(h => new Date(h.time).toLocaleTimeString());
    chartData.datasets[0].data = history.map((h, i) =>
      i === 0 ? 0 : parseFloat(((h.value - history[i - 1].value) * 2).toFixed(4))
    );
    mainChart.update("none");

    miniData.labels = chartData.labels;
    miniData.datasets[0].data = history.map(h => h.value.toFixed(3));
    miniChart.update("none");
  }
}

// Flow rate per valve constant (mirrors backend.py)
const FLOW_RATE_LPS_PER_VALVE = 30.0 / 60.0;

// =====================================================
// IPC: SYNC ACTIVE VALVES TO BACKEND
// =====================================================

async function syncValves() {
  await window.api.setValves(Array.from(activeValves));
  activeCount.innerText = activeValves.size;
}

// =====================================================
// LIVE PUSH UPDATES FROM MAIN PROCESS
// =====================================================

window.api.onStateUpdate((state) => {
  updateUi(state);
  if (state.auto_stopped) toast("Timer elapsed — system stopped");
});

// =====================================================
// BUTTON WIRING
// =====================================================

document.getElementById("startBtn").addEventListener("click", async () => {
  await window.api.start();
  toast("System started");
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await window.api.stop();
  toast("System stopped");
});

document.getElementById("emergencyBtn").addEventListener("click", async () => {
  await window.api.emergency();

  // Clear local valve state immediately
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => {
    b.classList.remove("online");
    b.classList.add("offline");
  });

  // Flash the UI
  document.body.classList.add("emergency");
  setTimeout(() => document.body.classList.remove("emergency"), 1200);

  toast("⚠ EMERGENCY STOP triggered", true);
});

document.getElementById("resetValvesBtn").addEventListener("click", async () => {
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => b.classList.remove("online", "offline", "done"));
  await syncValves();
  toast("Valves reset");
});

document.getElementById("resetTotalBtn").addEventListener("click", async () => {
  await window.api.resetTotal();
  totalText.innerText = "0.00";
  lastFlowTotal = 0;
  chartData.labels = [];
  chartData.datasets[0].data = [];
  miniData.labels = [];
  miniData.datasets[0].data = [];
  valveCumulativeFlow.fill(0);
  valveChartData.datasets[0].data = [...valveCumulativeFlow];
  mainChart.update();
  miniChart.update();
  valveChart.update();
  document.querySelectorAll(".box.done").forEach(b => b.classList.remove("done"));
  toast("Total flow reset");
});

document.getElementById("csvBtn").addEventListener("click", async () => {
  const result = await window.api.generateCsv();
  if (result.status === "ok") {
    toast(`CSV saved: ${result.path}`);
  } else {
    toast(`CSV error: ${result.message}`, true);
  }
});

// =====================================================
// ROW SELECT — activate a full row of 7 valves
// =====================================================

document.getElementById("selectAllBtn").addEventListener("click", async () => {
  activeValves.clear();
  for (let i = 1; i <= VALVE_COUNT; i++) activeValves.add(i);
  document.querySelectorAll(".box").forEach(b => {
    b.classList.add("online");
    b.classList.remove("offline");
  });
  await syncValves();
  toast("All 49 valves selected");
});

document.getElementById("areaSelect").onchange = async (e) => {
  const val = e.target.value;
  if (!val) return;

  activeValves.clear();

  if (val.startsWith("row-")) {
    const row = parseInt(val.slice(4));
    const start = (row - 1) * 7 + 1;
    for (let i = start; i < start + 7; i++) activeValves.add(i);
    toast(`Row ${row} selected (valves ${start}–${start + 6})`);
  } else if (val.startsWith("col-")) {
    const col = parseInt(val.slice(4)); // 1-indexed
    for (let r = 0; r < 7; r++) activeValves.add(col + r * 7);
    toast(`Col ${col} selected (valves ${col},${col+7},${col+14}…)`);
  }

  document.querySelectorAll(".box").forEach((b, i) => {
    b.classList.toggle("online", activeValves.has(i + 1));
    b.classList.remove("offline");
  });

  await syncValves();
};

// =====================================================
// TIME SELECT
// =====================================================

document.getElementById("timeSelect").addEventListener("change", async (e) => {
  const ms = parseInt(e.target.value) || null;
  await window.api.setDuration(ms);
  toast(ms ? `Timer set to ${e.target.options[e.target.selectedIndex].text}` : "Timer off — runs until stop");
});

// =====================================================
// RANDOM MODE
// =====================================================

let randomMode = false;
const randomBtn = document.getElementById("randomBtn");
const randomCapsBtn = document.getElementById("randomCapsBtn");
let randomCapsMode = false;

randomBtn.addEventListener("click", async () => {
  randomMode = !randomMode;
  randomBtn.classList.toggle("btn-random-on", randomMode);
  await window.api.setRandom(randomMode);
  toast(randomMode ? "Random mode ON — valves cycle independently" : "Random mode OFF");
});

randomCapsBtn.addEventListener("click", async () => {
  const result = await window.api.setRandomCaps();
  randomCapsMode = !!result.random_caps;
  randomCapsBtn.classList.toggle("btn-random-on", randomCapsMode);
  toast(randomCapsMode ? "Natural caps enabled — each valve gets 2–5 dL" : "Natural caps disabled");
});

// =====================================================
// FLOW CAP INPUT
// =====================================================

document.getElementById("flowCapInput").addEventListener("change", async (e) => {
  const dl = parseFloat(e.target.value);
  const limitL = (dl > 0) ? dl * 0.1 : null;
  await window.api.setFlowLimit(limitL);
  toast(limitL ? `Flow cap: ${dl} dL/valve` : "Flow cap disabled");
});

// =====================================================
// CLOCK
// =====================================================

function updateClock() {
  sbTime.textContent = new Date().toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();

// =====================================================
// INITIAL STATE LOAD
// =====================================================

async function loadInitialState() {
  const state = await window.api.getState();

  // Restore active valves from backend default
  activeValves = new Set(state.active_ids || []);
  document.querySelectorAll(".box").forEach((b) => {
    const id = parseInt(b.id.replace("valve-", ""));
    b.classList.toggle("online", activeValves.has(id));
  });

  if (state.valve_flow_limit) {
    const el = document.getElementById("flowCapInput");
    if (el) el.value = (state.valve_flow_limit * 10).toFixed(1);
  }

  if (state.random_caps) {
    randomCapsMode = true;
    randomCapsBtn.classList.add("btn-random-on");
  }

  updateUi(state);
}

loadInitialState();

// =====================================================
// TOAST HELPER
// =====================================================

let toastTimer = null;

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = isError ? "var(--red)" : "var(--border-hi)";
  el.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}
