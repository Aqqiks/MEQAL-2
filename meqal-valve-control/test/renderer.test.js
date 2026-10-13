// ============================================================================
// MEQAL RENDERER — smoke test
// ----------------------------------------------------------------------------
// Runs renderer/renderer.js against a minimal stand-in for the page (no
// browser) and checks what the operator would see for a given backend state:
// the CAN/controller status line and how each valve box is drawn.
// ============================================================================
"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const fs     = require("fs");
const path   = require("path");
const vm     = require("vm");

function loadRenderer() {
  const els = new Map();
  const mkEl = (id) => {
    const classes = new Set();
    const el = {
      id, style: {}, title: "", textContent: "", innerText: "", value: "",
      options: [], selectedIndex: 0, children: [], listeners: {},
      classList: {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; want ? classes.add(c) : classes.delete(c); return want; },
        contains: (c) => classes.has(c),
      },
      classes,
      addEventListener(evt, fn) { (el.listeners[evt] ||= []).push(fn); },
      appendChild(child) { el.children.push(child); if (child.id) els.set(child.id, child); return child; },
      getContext: () => ({}),
    };
    Object.defineProperty(el, "className", {
      get: () => Array.from(classes).join(" "),
      set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); },
    });
    return el;
  };
  const byId = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };

  let onState = null;
  const calls = [];
  const api = new Proxy({}, {
    get: (_t, name) => {
      if (name === "onStateUpdate") return (cb) => { onState = cb; };
      if (name === "getState") return async () => ({ active_ids: [], valve_states: [], running: false });
      return async (...args) => { calls.push([name, ...args]); return { status: "ok", mode: args[0] }; };
    },
  });

  const document = {
    getElementById: byId,
    createElement: () => mkEl(""),
    querySelectorAll: (sel) => {
      const all = Array.from(els.values());
      if (sel === ".box") return all.filter(e => e.classes.has("box"));
      if (sel === ".box.done") return all.filter(e => e.classes.has("box") && e.classes.has("done"));
      return [];
    },
    body: mkEl("body"),
  };
  const window = { api };

  const file = path.join(__dirname, "..", "renderer", "renderer.js");
  const fn = vm.compileFunction(fs.readFileSync(file, "utf8"),
    ["window", "document", "setInterval", "setTimeout", "clearTimeout", "Chart"], { filename: file });
  fn(window, document, () => 0, () => 0, () => {}, undefined);

  return { byId, push: (state) => onState(state), calls, box: (i) => byId(`valve-${i}`) };
}

const base = {
  running: false, mode: "continuous", active_ids: [], flow_total: 0, flow_history: [],
  valve_states: new Array(50).fill(false), valve_flow_accum: new Array(50).fill(0), limited_ids: [],
  can_connected: true, can_simulated: false, can_tx_ok: true,
  controllers: [1, 2, 3, 4, 5].map(id => ({ id, status: "online", boots: 0 })),
  offline_controllers: [], stuck_open_ids: [],
};

test("Healthy system: status line says CAN OK with all controllers, nothing flagged", () => {
  const ui = loadRenderer();
  ui.push({ ...base });
  assert.equal(ui.byId("canStatus").textContent, "CAN OK · 5/5 controllers");
  assert.equal(ui.byId("canDot").className, "can-dot ok");
  for (let i = 1; i <= 49; i++) {
    assert.equal(ui.box(i).classes.has("nolink"), false);
    assert.equal(ui.box(i).classes.has("stuck"), false);
  }
});

test("Controllers 1, 3, 4 not responding: named in the status line, their valves marked", () => {
  const ui = loadRenderer();
  const valve_states = new Array(50).fill(false);
  for (let v = 1; v <= 49; v++) valve_states[v] = true;      // the app commanded everything open
  ui.push({
    ...base, running: true, active_ids: Array.from({ length: 49 }, (_, i) => i + 1), valve_states,
    controllers: [1, 2, 3, 4, 5].map(id => ({ id, status: [1, 3, 4].includes(id) ? "offline" : "online", boots: 0 })),
    offline_controllers: [1, 3, 4],
  });
  assert.equal(ui.byId("canStatus").textContent, "CONTROLLER 1, 3, 4 NOT RESPONDING");
  assert.equal(ui.byId("canDot").className, "can-dot err");
  const marked = [];
  for (let i = 1; i <= 49; i++) if (ui.box(i).classes.has("nolink")) marked.push(i);
  assert.deepEqual(marked, [...Array(10).keys()].map(k => k + 1)
    .concat([...Array(20).keys()].map(k => k + 21)));          // 1-10 and 21-40
  assert.match(ui.box(25).title, /controller 3 is not responding/);
  assert.equal(ui.box(15).title, "");
});

test("Stuck-open valve, transmit failure, simulation and lost link are all shown distinctly", () => {
  const ui = loadRenderer();

  ui.push({ ...base, stuck_open_ids: [13] });
  assert.equal(ui.byId("canStatus").textContent, "CAN OK · 5/5 controllers · VALVE 13 STILL OPEN");
  assert.equal(ui.byId("canDot").className, "can-dot err");
  assert.equal(ui.box(13).classes.has("stuck"), true);
  assert.equal(ui.box(14).classes.has("stuck"), false);

  ui.push({ ...base, can_tx_ok: false });
  assert.equal(ui.byId("canStatus").textContent, "CAN TX FAILING");
  assert.equal(ui.box(1).classes.has("nolink"), true);
  assert.equal(ui.box(13).classes.has("stuck"), false, "flags clear when the state clears");

  ui.push({ ...base, can_connected: false, can_simulated: true, controllers: base.controllers.map(c => ({ ...c, status: "unknown" })) });
  assert.equal(ui.byId("canStatus").textContent, "CAN SIM");
  assert.equal(ui.box(1).classes.has("nolink"), false, "simulation never marks valves as lost");

  ui.push({ ...base, can_connected: false, can_simulated: false });
  assert.equal(ui.byId("canStatus").textContent, "NO CAN");
  assert.equal(ui.byId("canDot").className, "can-dot err");
});

test("While controllers are still coming up the count is honest, and notices are shown", () => {
  const ui = loadRenderer();
  ui.push({ ...base, controllers: [1, 2, 3, 4, 5].map(id => ({ id, status: id <= 2 ? "online" : "unknown", boots: 0 })) });
  assert.equal(ui.byId("canStatus").textContent, "CAN OK · 2/5 controllers");
  assert.equal(ui.byId("canDot").className, "can-dot err");

  ui.push({ ...base, notice: "Controller 3 restarted — valves 21-30 dropped", notice_error: true });
  assert.equal(ui.byId("toast").textContent, "Controller 3 restarted — valves 21-30 dropped");
  assert.equal(ui.byId("toast").classes.has("show"), true);
});

test("A state from an older backend (no controller fields) still renders", () => {
  const ui = loadRenderer();
  ui.push({ running: false, active_ids: [3], valve_states: [], can_connected: true, can_simulated: false });
  assert.equal(ui.byId("canStatus").textContent, "CAN OK");
  assert.equal(ui.box(3).classes.has("online"), true);
});
