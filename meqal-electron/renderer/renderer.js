// MEQAL FRONTEND CONTROLLER — ELECTRON VERSION
// This renderer script drives the MEQAL valve control UI. It manages the valve grid,
// Chart.js charts, button wiring, IPC calls via window.api, and live state updates pushed from the main process.


// CONFIG
// These constants mirror the backend configuration and are used for rendering the valve grid and calculating flow rates.
const GRID_SIZE        = 7;
const VALVE_COUNT      = 49;
const MAX_CHART_POINTS = 60;


// STATE
// Local UI state tracking which valves are selected in the grid and whether the system is currently running.
let activeValves = new Set();
let isRunning    = false;


// ELEMENTS
// References to DOM elements used for displaying system status, flow data, and connection indicators.
const totalText   = document.getElementById("totalText");
const activeCount = document.getElementById("activeCount");
const flowRateEl  = document.getElementById("flowRate");
const sysStatus   = document.getElementById("sysStatus");
const pulseDot    = document.getElementById("pulseDot");
const sbStatus    = document.getElementById("sbStatus");
const sbTime      = document.getElementById("sbTime");
const canStatus   = document.getElementById("canStatus");
const canDot      = document.getElementById("canDot");


// VALVE GRID
// Build the 7×7 interactive grid of valve boxes. Each box is clickable to toggle the valve on or off.
// Clicking a box updates the local activeValves Set and syncs the change to the main process via IPC.
const valveGrid = document.getElementById("valveGrid");

// We create 49 boxes for the valves, assigning them IDs from valve-1 to valve-49. Each box has an onclick handler that toggles its active state, 
// -> updates the local activeValves set, and calls syncValves to send the updated selection to the backend.
for (let i = 1; i <= VALVE_COUNT; i++) {
  const box = document.createElement("div");
  box.className = "box";
  box.id        = `valve-${i}`;
  box.innerText = i;
  // The onclick handler toggles the valve's active state in the local activeValves set, updates the box's visual state, and 
  // -> calls syncValves to send the new selection to the main process via IPC.
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
  // Each box is appended to the valveGrid container, which uses CSS grid layout to arrange them in a 7×7 format.
  valveGrid.appendChild(box);
}


// PER-VALVE CUMULATIVE FLOW BAR CHART
// Displays the accumulated flow in litres for each of the 49 valves as a bar chart.
// Updated on every state tick while the system is running.
const valveLabels         = Array.from({ length: VALVE_COUNT }, (_, i) => `V${i + 1}`);
const valveCumulativeFlow = new Array(VALVE_COUNT).fill(0);

// The valveChart is a bar chart that shows the cumulative flow for each valve. It is updated on every state tick while the system is running, 
// accumulating flow based on which valves are active. The chart uses a green color scheme and has customized axes and tooltips for clarity.
const valveChartCtx = document.getElementById("valveChartCanvas").getContext("2d");

// The valveChartData object holds the labels (valve numbers) and dataset (cumulative flow values) for the per-valve bar chart.
const valveChartData = {
  labels: valveLabels,
  datasets: [{
    label:           "Cumulative Flow (dL)",
    data:            [...valveCumulativeFlow],
    backgroundColor: "rgba(34,197,94,0.45)",
    borderColor:     "#22c55e",
    borderWidth: 1,
  }]
};

// The valveChart is a bar chart that shows the cumulative flow for each valve. It is updated on every state tick while the system is running, 
// accumulating flow based on which valves are active.
const valveChart = new Chart(valveChartCtx, {
  type: "bar",
  data: valveChartData,
  options: {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0e1318",
        borderColor:     "#1e2d3d",
        borderWidth:     1,
        titleColor:      "#7a8fa8",
        bodyColor:       "#e2eaf4",
        bodyFont:        { family: "JetBrains Mono", size: 12 },
        callbacks: {
          label: function(context) {
            return ((context.parsed.y || 0) * 10).toFixed(3) + " dL";
          }
        }
      }
    },
    scales: {
      x: {
        ticks: {
          color:       "#3d5268",
          font:        { family: "JetBrains Mono", size: 9 },
          autoSkip:    false,
          maxRotation: 90,
          minRotation: 90,
        },
        grid: { color: "rgba(30,45,61,0.6)" },
      },
      y: {
        ticks: {
          color: "#3d5268",
          font: { family: "JetBrains Mono", size: 9 },
          callback: function(value) {
            return (value * 10).toFixed(3);
          }
        },
        grid: { color: "rgba(30,45,61,0.6)" },
        beginAtZero: true,
      }
    }
  }
});


// MAIN FLOW CHART
// A live line chart showing the instantaneous flow rate (L/s) over time, derived from the flow_history array sent by the main process.
const chartCtx = document.getElementById("chartCanvas").getContext("2d");

// The chartData object holds the labels (timestamps) and dataset (cumulative flow per valve) for the main flow chart. It is updated on every state tick with the latest 
// -> flow_history data from the backend, showing the cumulative flow contribution per active valve over time.
const chartData = {
  labels: [],
  datasets: [{
    label:           "Cumulative Flow Per Valve (L)",
    data:            [],
    borderColor:     "#22c55e",
    backgroundColor: "rgba(34,197,94,0.08)",
    borderWidth:     1.5,
    pointRadius:     0,
    fill:            true,
    tension:         0.4,
  }]
};

// The mainChart is a line chart that plots the flow rate over time. It is updated on every state tick with the latest flow_history data from the backend, 
// showing the real-time flow dynamics of the system.
const mainChart = new Chart(chartCtx, {
  type: "line",
  data: chartData,
  options: {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0e1318",
        borderColor:     "#1e2d3d",
        borderWidth:     1,
        titleColor:      "#7a8fa8",
        bodyColor:       "#e2eaf4",
        bodyFont:        { family: "JetBrains Mono", size: 12 },
        callbacks: {
          label: function(context) {
            return (context.parsed.y || 0).toFixed(3) + " L";
          }
        }
      }
    },
    scales: {
      x: {
        ticks: { color: "#3d5268", font: { family: "JetBrains Mono", size: 9 }, maxTicksLimit: 8 },
        grid:  { color: "rgba(30,45,61,0.6)" },
      },
      y: {
        ticks: {
          color: "#3d5268",
          font: { family: "JetBrains Mono", size: 9 },
          callback: function(value) {
            return value.toFixed(3);
          }
        },
        grid: { color: "rgba(30,45,61,0.6)" },
        beginAtZero: true,
      }
    }
  }
});


// MINI FLOW HISTORY CHART
// A compact sparkline chart in the sidebar that plots cumulative total flow over time.
// Uses blue colouring to visually distinguish it from the main flow rate chart.
const miniCtx = document.getElementById("totalChartCanvas").getContext("2d");

// The miniData object holds the labels and dataset for the mini chart. It is updated with the same flow_history data as the main chart, but plots the total cumulative flow instead of the instantaneous rate.
const miniData = {
  labels: [],
  datasets: [{
    data:            [],
    borderColor:     "#3b82f6",
    backgroundColor: "rgba(59,130,246,0.08)",
    borderWidth:     1.5,
    pointRadius:     0,
    fill:            true,
    tension:         0.4,
  }]
};

// The mini chart is a simplified line chart without axes or tooltips, designed to show the overall trend of total flow over time in a compact form.
const miniChart = new Chart(miniCtx, {
  type: "line",
  data: miniData,
  options: {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           false,
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: "#0e1318",
        borderColor:     "#1e2d3d",
        borderWidth:     1,
        titleColor:      "#7a8fa8",
        bodyColor:       "#e2eaf4",
        bodyFont:        { family: "JetBrains Mono", size: 12 },
        callbacks: {
          label: function(context) {
            return (context.parsed.y || 0).toFixed(3) + " L";
          }
        }
      }
    },
    scales: {
      x: { display: false },
      y: {
        display:     true,
        ticks: {
          color: "#3d5268",
          font: { family: "JetBrains Mono", size: 8 },
          maxTicksLimit: 4,
          callback: function(value) {
            return value.toFixed(3);
          }
        },
        grid: { color: "rgba(30,45,61,0.4)" },
        beginAtZero: true,
      }
    }
  }
});


// UPDATE UI FROM STATE
// Called with a state object from the main process (either via initial load or live push).
// Updates all display elements: totals, flow rate, running status, CAN badge, valve grid, and charts.
let lastFlowTotal = 0;

// The updateUi function takes the latest system state object and updates all relevant UI elements accordingly. 
// It handles the total flow display, active valve count, instantaneous flow rate, running status indicator, CAN connection badge, valve grid states, 
// -> cumulative flow bar chart, and the main flow rate and mini total history charts. This function is called both on initial load with 
// -> the fetched state and on every live state update pushed from the main process.
function updateUi(state) {

  const total    = state.flow_total || 0;
  const actCount = (state.active_ids || []).length;
  const flowNow  = (total - lastFlowTotal) * 2; // per-second estimate (tick = 0.5s)
  lastFlowTotal  = total;

  // Update the total flow display, active valve count, and instantaneous flow rate
  totalText.innerText   = total.toFixed(2);
  activeCount.innerText = actCount;
  flowRateEl.innerText  = flowNow.toFixed(2);

  // Update the running/idle status indicator and pulse dot animation
  isRunning = state.running;
  pulseDot.classList.toggle("stopped", !isRunning);
  sysStatus.textContent = isRunning ? "RUNNING" : "IDLE";
  sbStatus.textContent  = isRunning
    ? `Running · ${actCount} valves active`
    : "System idle";

  // Update the CAN bus connection badge based on whether the main process has an active CAN channel
  const connected       = !!state.can_connected;
  canDot.className      = "can-dot " + (connected ? "ok" : "err");
  canStatus.textContent = connected ? "CAN OK" : "NO CAN";

  // Sync the random cap mode button visual state with the backend flag
  const capsOn   = !!state.random_caps;
  randomCapsMode = capsOn;
  randomCapsBtn.classList.toggle("btn-random-on", capsOn);

  // Ensure the UI selection stays in sync with the backend active valve IDs.
  activeValves = new Set(state.active_ids || activeValves);

  // Refresh the valve grid boxes to show selection and current open state. Selected valves remain highlighted
  // even if the backend has temporarily closed them during random/natural cycling.
  for (let i = 1; i <= VALVE_COUNT; i++) {
    const box = document.getElementById(`valve-${i}`);
    if (!box) continue;
    const isSelected = activeValves.has(i);
    const isOpen     = state.valve_states ? !!state.valve_states[i] : false;
    box.classList.toggle("online", isSelected || isOpen);
    box.classList.toggle("offline", false);
    if (!isSelected && !isOpen) box.classList.remove("done");
  }

  // Mark any valves that have reached their cumulative flow cap as "done" (amber) in the grid
  if (state.limited_ids) {
    for (const vid of state.limited_ids) {
      activeValves.delete(vid);
      const box = document.getElementById(`valve-${vid}`);
      if (box && !box.classList.contains("online")) box.classList.add("done");
    }
  }

  // Accumulate per-valve cumulative flow on each 0.5s tick and update the bar chart
  if (state.valve_states && state.running) {
    const tickFlow = FLOW_RATE_LPS_PER_VALVE * 0.5;
    for (let i = 1; i <= VALVE_COUNT; i++) {
      if (state.valve_states[i]) valveCumulativeFlow[i - 1] += tickFlow;
    }
    valveChartData.datasets[0].data = [...valveCumulativeFlow];
    valveChart.update("none");
  }

  // Rebuild the main flow rate chart and mini history sparkline from the latest flow_history array
  if (state.flow_history && state.flow_history.length > 0) {
    const history = state.flow_history;
    const activeCount = (state.active_ids || []).length || 1; // Avoid division by zero
    // The main chart plots cumulative flow per valve over time. Divide total cumulative flow by active valve count
    // to show how much each valve has contributed to the total (on average across active valves).
    // When valves close/cap, activeCount decreases, which properly flattens the per-valve contribution.
    chartData.labels           = history.map(h => new Date(h.time).toLocaleTimeString());
    chartData.datasets[0].data = history.map(h => {
      return parseFloat((h.value / activeCount).toFixed(3));
    });
    mainChart.update("none");
    // The mini chart plots the cumulative total flow over time, using the same history data but showing the total value.
    miniData.labels              = chartData.labels;
    miniData.datasets[0].data    = history.map(h => parseFloat(h.value.toFixed(3)));
    miniChart.update("none");
  }
}

// Flow rate constant per valve in L/s, mirrors FLOW_RATE_LPM / 60 from the backend
const FLOW_RATE_LPS_PER_VALVE = 30.0 / 60.0;


// SYNC VALVES
// Sends the current local activeValves set to the main process via IPC and updates the active count display.
async function syncValves() {
  await window.api.setValves(Array.from(activeValves));
  activeCount.innerText = activeValves.size;
}


// LIVE PUSH UPDATES
// Registers a listener for state-update events pushed from the main process via IPC.
// Each incoming state object is passed directly to updateUi; auto-stop events also show a toast.
window.api.onStateUpdate((state) => {
  updateUi(state);
  if (state.auto_stopped) toast("Timer elapsed — system stopped");
});


// BUTTON WIRING
// Each button invokes its corresponding window.api method and shows a toast confirmation.
document.getElementById("startBtn").addEventListener("click", async () => {
  await window.api.start();
  toast("System started");
});

document.getElementById("stopBtn").addEventListener("click", async () => {
  await window.api.stop();
  toast("System stopped");
});

// The emergency stop button clears local valve state immediately and flashes the body background red to signal the event
document.getElementById("emergencyBtn").addEventListener("click", async () => {
  await window.api.emergency();

  // Clear local valve selection and mark all grid boxes as offline
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => {
    b.classList.remove("online");
    b.classList.add("offline");
  });

  // Briefly flash the body background to provide a strong visual alert for the emergency stop event
  document.body.classList.add("emergency");
  setTimeout(() => document.body.classList.remove("emergency"), 1200);

  toast("⚠ EMERGENCY STOP triggered", true);
});

// The reset valves button clears the local activeValves set, updates the grid display to show all valves as offline, and sends an empty selection to the backend.
document.getElementById("resetValvesBtn").addEventListener("click", async () => {
  activeValves.clear();
  document.querySelectorAll(".box").forEach(b => b.classList.remove("online", "offline", "done"));
  await syncValves();
  toast("Valves reset");
});

// Reset the total flow counter in the backend and clear all chart data and valve cap indicators in the UI
document.getElementById("resetTotalBtn").addEventListener("click", async () => {
  await window.api.resetTotal();
  totalText.innerText              = "0.00";
  lastFlowTotal                    = 0;
  chartData.labels                 = [];
  chartData.datasets[0].data       = [];
  miniData.labels                  = [];
  miniData.datasets[0].data        = [];
  valveCumulativeFlow.fill(0);
  valveChartData.datasets[0].data  = [...valveCumulativeFlow];
  mainChart.update();
  miniChart.update();
  valveChart.update();
  document.querySelectorAll(".box.done").forEach(b => b.classList.remove("done"));
  toast("Total flow reset");
});

// Reset per-valve flow accumulators, caps, and limited valve markers
document.getElementById("resetCapsBtn").addEventListener("click", async () => {
  await window.api.resetCaps();
  valveCumulativeFlow.fill(0);
  valveChartData.datasets[0].data  = [...valveCumulativeFlow];
  valveChart.update();
  document.querySelectorAll(".box.done").forEach(b => b.classList.remove("done"));
  const capInput = document.getElementById("flowCapInput");
  if (capInput) capInput.value = "";
  toast("Valve caps reset");
});
// The generate CSV button invokes the backend CSV generation method and shows a toast with the result path or error message.
document.getElementById("csvBtn").addEventListener("click", async () => {
  const result = await window.api.generateCsv();
  if (result.status === "ok") {
    toast(`CSV saved: ${result.path}`);
  } else {
    toast(`CSV error: ${result.message}`, true);
  }
});


// ROW / COLUMN SELECT
// The select-all button activates every valve in the grid; the area select dropdown activates an entire
// -> row (horizontal) or column (vertical) of valves and syncs the selection to the backend.
document.getElementById("selectAllBtn").addEventListener("click", async () => {
  activeValves.clear();
  for (let i = 1; i <= VALVE_COUNT; i++) activeValves.add(i);
  document.querySelectorAll(".box").forEach(b => {
    b.classList.add("online");
    b.classList.remove("offline");
  });
  // After updating the local activeValves set and refreshing the grid display, we call syncValves to send the new selection to the main process via IPC.
  await syncValves();
  toast("All 49 valves selected");
});
// The area select dropdown has options with values like "row-1", "col-3", etc. When the selection changes,
// we parse the value to determine which row or column was selected, calculate the corresponding valve IDs,
// update the activeValves set, refresh the grid display, and sync the new selection to the backend.
document.getElementById("areaSelect").onchange = async (e) => {
  const val = e.target.value;
  if (!val) return;
  // Clear the current selection before applying the new one
  activeValves.clear();

  // Calculate which valve IDs belong to the selected row or column and add them to the active set
  if (val.startsWith("row-")) {
    const row   = parseInt(val.slice(4));
    const start = (row - 1) * 7 + 1;
    for (let i = start; i < start + 7; i++) activeValves.add(i);
    toast(`Row ${row} selected (valves ${start}–${start + 6})`);
  } else if (val.startsWith("col-")) {
    const col = parseInt(val.slice(4)); // 1-indexed column number
    for (let r = 0; r < 7; r++) activeValves.add(col + r * 7);
    toast(`Col ${col} selected (valves ${col},${col+7},${col+14}…)`);
  }

  // Refresh the grid boxes to reflect the new selection then sync to the main process
  document.querySelectorAll(".box").forEach((b, i) => {
    b.classList.toggle("online", activeValves.has(i + 1));
    b.classList.remove("offline");
  });
  // After updating the local activeValves set and refreshing the grid display, we call syncValves to send the new selection to the main process via IPC.
  await syncValves();
};


// TIME SELECT
// Reads the selected option value as milliseconds and sends it to the main process as the auto-stop duration.
// A value of 0 or empty is treated as no timer (runs until manually stopped).
document.getElementById("timeSelect").addEventListener("change", async (e) => {
  const ms = parseInt(e.target.value) || null;
  await window.api.setDuration(ms);
  toast(ms ? `Timer set to ${e.target.options[e.target.selectedIndex].text}` : "Timer off — runs until stop");
});


// RANDOM MODE
// Toggles the backend random valve cycling mode and the natural cap mode independently.
// Random mode makes active valves open and close at random intervals within RANDOM_MIN_MS – RANDOM_MAX_MS.
// Natural cap mode additionally assigns each valve a random 2–5 dL cumulative flow cap.
let randomMode      = false;
const randomBtn     = document.getElementById("randomBtn");
const randomCapsBtn = document.getElementById("randomCapsBtn");
let randomCapsMode  = false;

// The random mode button toggles the randomMode flag, updates the button's visual state, sends the new mode to the backend, and shows a toast confirmation.
randomBtn.addEventListener("click", async () => {
  randomMode = !randomMode;
  randomBtn.classList.toggle("btn-random-on", randomMode);
  await window.api.setRandom(randomMode);
  toast(randomMode ? "Random mode ON — valves cycle independently" : "Random mode OFF");
});

// The random caps button toggles the randomCapsMode flag, updates the button's visual state, sends the new mode to the backend, and shows a toast confirmation.
randomCapsBtn.addEventListener("click", async () => {
  const result   = await window.api.setRandomCaps();
  randomCapsMode = !!result.random_caps;
  randomCapsBtn.classList.toggle("btn-random-on", randomCapsMode);
  toast(randomCapsMode ? "Natural caps enabled — each valve gets 2–5 dL" : "Natural caps disabled");
});


// FLOW CAP INPUT
// Reads the typed value in decilitres, converts to litres, and sends it as the global per-valve flow cap.
// An empty or zero value clears the cap entirely.
document.getElementById("flowCapInput").addEventListener("change", async (e) => {
  const dl     = parseFloat(e.target.value);
  const limitL = (dl > 0) ? dl * 0.1 : null;
  await window.api.setFlowLimit(limitL);
  toast(limitL ? `Flow cap: ${dl} dL/valve` : "Flow cap disabled");
});


// CLOCK
// Updates the status bar time display every second.
function updateClock() {
  sbTime.textContent = new Date().toLocaleTimeString();
}
setInterval(updateClock, 1000);
updateClock();


// INITIAL STATE LOAD
// Fetches the current system state from the main process on startup and restores the UI to match it.
// This handles cases where the renderer is reloaded while the backend is already running.
async function loadInitialState() {
  const state = await window.api.getState();

  // Restore the active valve selection in the grid from the backend's persisted state
  activeValves = new Set(state.active_ids || []);
  document.querySelectorAll(".box").forEach((b) => {
    const id = parseInt(b.id.replace("valve-", ""));
    b.classList.toggle("online", activeValves.has(id));
  });

  // Restore the flow cap input field if a global limit was previously set
  if (state.valve_flow_limit) {
    const el = document.getElementById("flowCapInput");
    if (el) el.value = (state.valve_flow_limit * 10).toFixed(1);
  }

  // Restore the random caps button highlighted state if the mode was already active
  if (state.random_caps) {
    randomCapsMode = true;
    randomCapsBtn.classList.add("btn-random-on");
  }
  // Finally, call updateUi with the loaded state to sync all displays, charts, and indicators with the backend's current status.
  updateUi(state);
}
// On initial load, we fetch the current state from the main process and call updateUi to sync the entire UI with the backend.
loadInitialState();


// TOAST HELPER
// Displays a brief notification at the bottom-right of the screen for 3 seconds.
// Error toasts use a red border; normal toasts use the standard highlight border.
// Any active toast is dismissed before showing a new one to avoid stacking.
let toastTimer = null;

// Displays a toast message with optional error styling. The toast automatically disappears after 3 seconds, 
// -> and any existing toast is cleared before showing a new one.
function toast(msg, isError = false) {
  const el             = document.getElementById("toast");
  el.textContent       = msg;
  el.style.borderColor = isError ? "var(--red)" : "var(--border-hi)";
  el.classList.add("show");
  // Clear any existing toast timer to prevent multiple toasts from stacking; start a new timer to hide the toast after 3 seconds.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}
