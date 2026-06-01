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

// =====================================================
// BUILD VALVE GRID (7×7 = 49 boxes)
// =====================================================

const valveGrid = document.getElementById("valveGrid");

for (let i = 0; i < VALVE_COUNT; i++) {
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
      box.classList.add("online");
    }
    syncValves();
  };

  valveGrid.appendChild(box);
}

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
  flowRateEl.innerText  = (FLOW_RATE_LPS_PER_VALVE * actCount).toFixed(2);

  // Running state styling
  isRunning = state.running;
  pulseDot.classList.toggle("stopped", !isRunning);
  sysStatus.textContent = isRunning ? "RUNNING" : "IDLE";
  sbStatus.textContent  = isRunning
    ? `Running · ${actCount} valves active`
    : "System idle";

  // Update valve grid visuals from backend state
  if (state.valve_states) {
    state.valve_states.forEach((on, i) => {
      const box = document.getElementById(`valve-${i}`);
      if (box) box.classList.toggle("online", on);
    });
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
  document.querySelectorAll(".box").forEach(b => b.classList.remove("online", "offline"));
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
  mainChart.update();
  miniChart.update();
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

document.getElementById("areaSelect").onchange = async (e) => {
  const row = parseInt(e.target.value.replace("Row ", ""));

  activeValves.clear();
  for (let i = (row - 1) * 7; i < row * 7; i++) {
    activeValves.add(i);
  }

  document.querySelectorAll(".box").forEach((b, i) => {
    b.classList.toggle("online", activeValves.has(i));
    b.classList.remove("offline");
  });

  await syncValves();
  toast(`Row ${row} selected (valves ${(row-1)*7}–${row*7-1})`);
};

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
  document.querySelectorAll(".box").forEach((b, i) => {
    b.classList.toggle("online", activeValves.has(i));
  });

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
