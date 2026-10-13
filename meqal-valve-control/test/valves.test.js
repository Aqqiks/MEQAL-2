// ============================================================================
// MEQAL VALVE CONTROL — behaviour tests
// ----------------------------------------------------------------------------
// Run with:  npm test      (no hardware, no Electron window, a few seconds)
//
// Each test drives the real src/main.js through its IPC handlers, exactly as
// the UI does, and then checks what the simulated controllers are physically
// doing with their outputs. See test/sim.js for the hardware model.
// ============================================================================
"use strict";

const test   = require("node:test");
const assert = require("node:assert/strict");
const { rig, loadApp, range } = require("./sim");

const ALL = range(1, 49);

// Normal mode lets 2 valves join per 100 ms tick (soft start), so all 49 are
// open 2.5 s after Start. RAMP is that plus a margin.
const RAMP = 3500;

// ----------------------------------------------------------------------------
// Normal operation
// ----------------------------------------------------------------------------
test("Start opens exactly the selected valves and Stop closes them", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: [1, 12, 25, 38, 49] });
  r.app.invoke("api:start");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), [1, 12, 25, 38, 49]);

  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("Start with nothing selected opens all 49; Emergency Stop closes all and clears the selection", () => {
  const r = rig();
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), ALL);

  r.app.invoke("api:emergency");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
  const s = r.app.state();
  assert.equal(s.running, false);
  assert.deepEqual(s.active_ids, []);
});

test("Natural mode pulses each selected valve and everything is closed after Stop", () => {
  const r = rig();
  const sel = range(1, 10);
  r.app.invoke("api:set_mode", { mode: "natural" });
  r.app.invoke("api:valves", { active_ids: sel });
  r.app.invoke("api:start");

  const seenOpen = new Set(), seenClosed = new Set();
  for (let i = 0; i < 150; i++) {                   // 15 s, sampled every 100 ms
    r.clock.advance(100);
    const open = new Set(r.bus.openValves());
    for (const v of sel) (open.has(v) ? seenOpen : seenClosed).add(v);
    for (const v of open) assert.ok(sel.includes(v), `valve ${v} opened but was never selected`);
  }
  assert.deepEqual([...seenOpen].sort((a, b) => a - b), sel, "every selected valve should have opened");
  assert.deepEqual([...seenClosed].sort((a, b) => a - b), sel, "every selected valve should have paused");

  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("A per-valve cap permanently closes the valve once it is reached", () => {
  const r = rig();
  r.app.invoke("api:set_flow_limit", { limit: 0.5 });   // 0.5 L = 1 s at 30 L/min
  r.app.invoke("api:valves", { active_ids: [5, 6] });
  r.app.invoke("api:start");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), [5, 6]);
  r.clock.advance(2500);
  assert.deepEqual(r.bus.openValves(), []);
  assert.deepEqual(r.app.state().limited_ids.sort((a, b) => a - b), [5, 6]);
});

test("Random mode follows the driver script and goes idle when it finishes", () => {
  const r = rig();
  r.app.invoke("api:set_mode", { mode: "random" });
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  assert.equal(r.app.children.length, 1, "the driver script should have been started");
  const py = r.app.children[0];

  py.line("OPEN:3,4,49");
  r.clock.advance(400);
  assert.deepEqual(r.bus.openValves(), [3, 4, 49]);

  py.line("OPEN:");
  r.clock.advance(400);
  assert.deepEqual(r.bus.openValves(), []);

  r.clock.advance(1000);
  py.finish(0);
  r.clock.advance(300);
  assert.equal(r.app.state().running, false);
  assert.deepEqual(r.bus.openValves(), []);
});

test("In normal operation the Pi's CAN transmit queue never overflows", () => {
  const r = rig();
  r.app.invoke("api:start");
  r.clock.advance(5000);
  r.app.invoke("api:stop");
  r.clock.advance(2000);
  r.app.invoke("api:set_mode", { mode: "natural" });
  r.app.invoke("api:start");
  r.clock.advance(5000);
  r.app.invoke("api:emergency");
  r.clock.advance(2000);
  assert.equal(r.bus.stats.enobufs, 0, "frames were rejected by the kernel queue");
});

// ----------------------------------------------------------------------------
// The reported fault: "valves don't work at all"
// ----------------------------------------------------------------------------
test("FAULT valves dead: a controller that powers up after the app is started automatically", () => {
  const r = rig({ lateNodes: [1, 3, 4] });           // only 2 and 5 were up at launch (as found on the rig)
  r.clock.advance(2000);
  for (const id of [1, 3, 4]) r.node(id).powerOn();
  r.clock.advance(3000);

  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), ALL);

  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("FAULT valves dead: a controller that resets while running rejoins and obeys again", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), ALL);

  r.node(3).reset();                                 // brown-out / power glitch on controller 3
  r.clock.advance(100);
  assert.equal(r.bus.openValves().length, 39, "a reset controller drops its 10 outputs");
  r.clock.advance(3000);
  assert.deepEqual(r.bus.openValves(), ALL, "controller 3 should be back in control");

  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("A controller's boot-up message is answered with a start straight away", () => {
  // Whatever moment the controller restarts at, the start must follow its
  // boot-up message within 80 ms — not wait for the next 1 s retry.
  for (let offset = 0; offset < 250; offset += 10) {
    const r = rig();
    r.clock.advance(offset);
    r.node(4).reset();
    r.clock.advance(400 /* controller boot time */);
    const bootAt = r.clock.now;
    r.clock.advance(80);
    const started = r.bus.wire.some(f => f.id === 0x000 && f.data[0] === 0x01 && f.t >= bootAt);
    assert.ok(started, `no start within 80 ms of the boot-up message (offset ${offset} ms)`);
    assert.equal(r.node(4).state, "operational");
    assert.match(r.app.logText(), /Controller 4 restarted/);
  }
});

test("The app reports which controllers are not responding, and when they return", () => {
  const r = rig({ lateNodes: [1, 3, 4], settleMs: 3000 });
  assert.deepEqual(r.app.state().offline_controllers, [1, 3, 4]);
  assert.match(r.app.warnings().join("\n"), /controller 1\b/i);

  for (const id of [1, 3, 4]) r.node(id).powerOn();
  r.clock.advance(3000);
  assert.deepEqual(r.app.state().offline_controllers, []);
});

test("The start command is not repeated while every controller is healthy", () => {
  const r = rig();
  const t0 = r.clock.now;
  r.clock.advance(30000);
  assert.equal(r.bus.nmtStarts(t0), 0);
  assert.deepEqual(r.app.state().offline_controllers, []);
});

// ----------------------------------------------------------------------------
// The reported fault: "valves stay open no matter what"
// ----------------------------------------------------------------------------
test("FAULT valves stuck open: closing the window while valves are open closes every valve", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  assert.equal(r.bus.openValves().length, 49);

  r.app.closeWindow();
  r.clock.advance(1000);
  assert.deepEqual(r.bus.openValves(), []);
  assert.equal(r.app.status.exited, true);
});

test("FAULT valves stuck open: quitting (logout, Ctrl+Q, SIGTERM) while valves are open closes every valve", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  assert.equal(r.bus.openValves().length, 49);

  r.app.quit();
  r.clock.advance(1000);
  assert.deepEqual(r.bus.openValves(), []);
  assert.equal(r.app.status.exited, true);
});

test("Quitting does not hang when the bus is dead", () => {
  const r = rig();
  r.app.invoke("api:start");
  r.clock.advance(500);
  for (const n of r.bus.nodes.values()) n.powerOff();
  r.clock.advance(500);
  r.app.closeWindow();
  assert.equal(r.app.status.exited, true);
});

test("FAULT valves stuck open: a second copy of the app does not fight over the bus", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);

  // The desktop icon is clicked again while the app is already running.
  const second = loadApp({ clock: r.clock, bus: r.bus, singleInstanceLock: false });
  second.boot();
  r.clock.advance(2000);

  assert.equal(r.bus.opened, 1, "the second copy must not open can0");
  assert.ok(second.status.quitCalls >= 1, "the second copy must quit");
  assert.deepEqual(r.bus.openValves(), ALL, "the first copy stays in control");
});

test("A valve the controller keeps driving while commanded closed is reported", () => {
  const r = rig();
  r.node(2).forced.set(2, 370);                      // controller 2 output 3 = valve 13
  r.clock.advance(4000);
  assert.deepEqual(r.app.state().stuck_open_ids, [13]);
  assert.match(r.app.warnings().join("\n"), /valve 13\b/i);

  r.node(2).forced.clear();
  r.clock.advance(3000);
  assert.deepEqual(r.app.state().stuck_open_ids, []);
});

// ----------------------------------------------------------------------------
// The CAN link itself
// ----------------------------------------------------------------------------
test("A failed CAN transmit is detected instead of being silently ignored", () => {
  const r = rig();
  assert.equal(r.app.state().can_tx_ok, true);
  for (const n of r.bus.nodes.values()) n.powerOff(); // nobody acknowledges: the kernel queue fills
  r.clock.advance(3000);
  assert.ok(r.bus.stats.enobufs > 0, "test precondition: the kernel rejected frames");
  assert.equal(r.app.state().can_tx_ok, false);
  assert.match(r.app.warnings().join("\n"), /\[CAN\].*(transmit|TX)/i);

  for (const n of r.bus.nodes.values()) n.powerOn();
  r.clock.advance(4000);
  assert.equal(r.app.state().can_tx_ok, true);
  assert.deepEqual(r.app.state().offline_controllers, []);
});

test("can0 missing at launch: the app connects by itself once the interface appears", () => {
  const r = rig({ bus: { present: false } });
  assert.equal(r.app.state().can_connected, false);

  r.bus.present = true;                               // e.g. can-up.sh run afterwards
  r.clock.advance(35000);
  assert.equal(r.app.state().can_connected, true);

  r.app.invoke("api:valves", { active_ids: [7] });
  r.app.invoke("api:start");
  r.clock.advance(1000);
  assert.deepEqual(r.bus.openValves(), [7]);
});

test("can0 bounced under the running app (ip link down/up): the app keeps control", () => {
  const r = rig();
  r.bus.linkDown();
  r.clock.advance(200);
  r.bus.linkUp();
  r.clock.advance(6000);
  assert.deepEqual(r.app.state().offline_controllers, []);

  r.app.invoke("api:valves", { active_ids: [20, 21] });
  r.app.invoke("api:start");
  r.clock.advance(1000);
  assert.deepEqual(r.bus.openValves(), [20, 21]);
  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("Without the CAN driver the app says so and refuses to start: it never pretends", () => {
  const r = rig({ app: { socketcanMissing: true } });
  const s = r.app.state();
  assert.equal(s.can_connected, false);
  assert.equal(s.can_simulated, false, "a missing driver is an error, not a simulation");
  assert.equal(s.can_error.label, "CAN DRIVER MISSING");
  assert.match(r.app.logText(), /socketcan driver could not be loaded/);
  assert.match(r.app.logText(), /npm run setup/);

  const res = r.app.invoke("api:start");
  assert.equal(res.status, "blocked");
  assert.match(res.message, /Cannot start/);
  r.clock.advance(1000);
  assert.equal(r.app.state().running, false);
  assert.equal(r.app.state().flow_total, 0);
});

test("Simulation runs only when it is asked for (MEQAL_SIMULATE=1) and never touches the CAN bus", () => {
  const r = rig({ app: { env: { MEQAL_SIMULATE: "1" } } });
  const s = r.app.state();
  assert.equal(s.can_simulated, true);
  assert.equal(s.can_error, null);
  assert.equal(r.app.invoke("api:start").status, "started");
  r.clock.advance(5000);
  assert.equal(r.app.state().running, true);
  assert.ok(r.app.state().flow_total > 0);
  assert.equal(r.bus.opened, 0, "simulation must not open can0 even though it exists");
  assert.deepEqual(r.bus.openValves(), []);
});

// ----------------------------------------------------------------------------
// Supervision details
// ----------------------------------------------------------------------------
test("A controller that restarts every time its valves open ends the run instead of cycling forever", () => {
  const r = rig();
  r.node(3).maxOpen = 5;                              // weak supply on controller 3: more than 5 coils = brown-out
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(10000);

  const s = r.app.state();
  assert.equal(s.running, false, "the run must have been stopped");
  assert.match(r.app.warnings().join("\n"), /Controller 3 restarted 3 times/);
  assert.deepEqual(r.bus.openValves(), []);

  const boots = r.node(3).boots;
  r.clock.advance(10000);
  assert.equal(r.node(3).boots, boots, "no further restarts once stopped");
  assert.deepEqual(r.app.state().offline_controllers, [], "controller 3 is back and idle");
});

test("A single controller restart during a run does not stop the run", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  r.node(5).reset();
  r.clock.advance(5000);
  assert.equal(r.app.state().running, true);
  assert.deepEqual(r.bus.openValves(), ALL);
});

test("A blocked event loop does not raise false 'controller stopped responding' alarms", () => {
  // After a stall the overdue supervision timer can run before the frames
  // that arrived meanwhile are handled. Try every phase between the two.
  for (let offset = 0; offset < 250; offset += 5) {
    const r = rig();
    r.clock.advance(offset);
    r.clock.now += 3000;                              // nothing ran for 3 s, then everything is overdue
    r.clock.advance(3000);
    assert.doesNotMatch(r.app.warnings().join("\n"), /stopped responding|not responding/, `false alarm at offset ${offset} ms`);
    assert.deepEqual(r.app.state().offline_controllers, []);
  }
});

test("A controller fault message (EMCY) is logged with its meaning", () => {
  const r = rig();
  // Controller 3: generic voltage error 0x3000, description 0x40 = supply undervoltage.
  r.bus.nodeTransmit(r.node(3), 0x083, Buffer.from([0x00, 0x30, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00]));
  let w = r.app.warnings().join("\n");
  assert.match(w, /Controller 3 reports a fault: supply voltage out of range \(UNDERVOLTAGE\)/);
  assert.match(w, /raw 0030010040000000/);

  // The ten frames controller 2 really sent on 2026-10-08 when all 49 valves
  // were started: one per output, the output number in the high half of byte 3.
  for (const hex of ["02f0011010000000", "02f0012010000000", "02f0013010000000", "02f0014010000000", "02f0015010000000",
                     "02f0016010000000", "02f0017010000000", "02f0018010000000", "02f0019010000000", "02f001a010000000"]) {
    r.bus.nodeTransmit(r.node(2), 0x082, Buffer.from(hex, "hex"));
  }
  r.clock.advance(500);
  w = r.app.warnings().join("\n");
  assert.match(w, /Controller 2 could not drive the commanded current on outputs 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 \(valves 11, 12, 13, 14, 15, 16, 17, 18, 19, 20\) — supply voltage too low/);
  assert.equal(w.match(/Controller 2 could not drive/g).length, 1, "ten frames, one line");

  // A single output is more likely a wiring fault, and a plain number is accepted too.
  r.bus.nodeTransmit(r.node(5), 0x085, Buffer.from([0x02, 0xF0, 0x01, 0x70, 0x10, 0x00, 0x00, 0x00]));
  r.clock.advance(500);
  assert.match(r.app.warnings().join("\n"), /Controller 5 could not drive the commanded current on output 7 \(valve 47\) — coil disconnected or shorted/);

  // "Error reset" frames: silent while faults remain, one line when all are gone.
  r.bus.nodeTransmit(r.node(2), 0x082, Buffer.from("0000010000000000", "hex"));
  r.bus.nodeTransmit(r.node(2), 0x082, Buffer.from("0000000000000000", "hex"));
  assert.equal(r.app.logText().match(/Controller 2: all faults cleared/g).length, 1);
});

test("Garbage on the bus never crashes the app or confuses it for long", () => {
  const r = rig();
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 5000; i++) {
    const id  = rnd(0x800);
    const len = rnd(9);
    const data = Buffer.from(Array.from({ length: len }, () => rnd(256)));
    for (const c of r.bus.channels) c._deliver({ id, data });
    if (i % 50 === 0) r.clock.advance(1);
  }
  for (const c of r.bus.channels) {                   // frame kinds we do not use
    for (const l of c._onMessage) {
      l.cb.call(l.ctx, { id: 0x181, ext: true,  data: Buffer.alloc(8) });
      l.cb.call(l.ctx, { id: 0x181, rtr: true,  data: Buffer.alloc(0) });
      l.cb.call(l.ctx, { id: 0x181, err: true,  data: Buffer.alloc(8) });
      l.cb.call(l.ctx, { id: 0x181 });
      l.cb.call(l.ctx, null);
    }
  }
  r.clock.advance(5000);
  const s = r.app.state();
  assert.deepEqual(s.offline_controllers, []);
  assert.deepEqual(s.stuck_open_ids, []);
  assert.deepEqual(r.bus.openValves(), []);
  assert.doesNotMatch(r.app.logText(), /RX handler error/);

  r.app.invoke("api:valves", { active_ids: [1, 49] });
  r.app.invoke("api:start");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), [1, 49]);
});

test("The UI is told when a controller drops out and when it returns", () => {
  const r = rig();
  r.node(2).powerOff();
  r.clock.advance(2500);
  let p = r.app.status.lastPush;
  assert.deepEqual(p.offline_controllers, [2]);
  assert.equal(p.controllers[1].status, "offline");
  assert.match(String(p.notice), /Controller 2 not responding/);

  r.node(2).powerOn();
  r.clock.advance(2500);
  p = r.app.status.lastPush;
  assert.deepEqual(p.offline_controllers, []);
  assert.equal(p.controllers[1].status, "online");
  assert.match(String(p.notice), /Controller 2 is back/);
});

test("can0 missing at launch: Start is refused, and nothing opens by itself when the interface appears", () => {
  const r = rig({ bus: { present: false } });
  let s = r.app.state();
  assert.equal(s.can_simulated, false, "missing hardware is an error, not a simulation");
  assert.equal(s.can_error.label, "NO can0");

  r.app.invoke("api:valves", { active_ids: ALL });
  const res = r.app.invoke("api:start");
  assert.equal(res.status, "blocked");
  assert.equal(r.app.state().running, false);

  r.bus.present = true;                               // the CAN board shows up
  for (let i = 0; i < 50; i++) {
    r.clock.advance(100);
    assert.deepEqual(r.bus.openValves(), [], "a valve opened by itself");
  }
  s = r.app.state();
  assert.equal(s.can_connected, true, "connects by itself");
  assert.equal(s.can_error, null);
  assert.equal(s.running, false);

  assert.equal(r.app.invoke("api:start").status, "started");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), ALL);
});

test("Exit reports when it could not close the valves", () => {
  const dead = rig();
  dead.app.invoke("api:start");
  dead.clock.advance(500);
  for (const n of dead.bus.nodes.values()) n.powerOff();
  dead.clock.advance(500);
  dead.app.closeWindow();
  assert.match(dead.app.warnings().join("\n"), /could NOT deliver the close commands/);

  const down = rig();
  down.bus.linkDown();
  down.bus.present = false;                           // adapter gone for good
  down.clock.advance(2000);
  down.app.closeWindow();
  assert.match(down.app.warnings().join("\n"), /CAN link was down/);

  const ok = rig();
  ok.app.invoke("api:start");
  ok.clock.advance(500);
  ok.app.closeWindow();
  assert.match(ok.app.logText(), /Exit — all valves commanded closed/);
  assert.doesNotMatch(ok.app.warnings().join("\n"), /CHECK THE VALVES/);
});

test("Stop and Emergency Stop still close everything while a controller is restarting", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  r.node(1).reset();
  r.clock.advance(150);                               // controller 1 is mid-boot
  r.app.invoke("api:emergency");
  r.clock.advance(3000);                              // it comes back, is started, and must stay closed
  assert.deepEqual(r.bus.openValves(), []);
  assert.equal(r.node(1).state, "operational");
});

test("FAULT valves stuck open: a controller knocked out of operational while open is recovered and closed", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);

  // Another tool on the bus sends NMT "enter pre-operational" to controller 3
  // (no reset, no boot-up message): it stops listening but keeps driving.
  const tool = r.bus.open("can0");
  tool.start();
  tool.send({ id: 0x000, data: Buffer.from([0x80, 0x03]) });
  r.clock.advance(50);
  assert.equal(r.node(3).state, "preop");

  r.app.invoke("api:stop");
  r.clock.advance(300);
  assert.deepEqual(r.bus.openValves(), range(21, 30), "controller 3 holds its last command while not operational");

  r.clock.advance(3000);                              // supervision notices the silence and starts it again
  assert.equal(r.node(3).state, "operational");
  assert.deepEqual(r.bus.openValves(), []);
});

// ----------------------------------------------------------------------------
// Link outages (found with the real app on a real kernel: a socket opened
// while the interface is down dies immediately, so reconnecting blindly loops)
// ----------------------------------------------------------------------------
test("A long can0 outage: one message, no reconnect storm, control is back when the link returns", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);

  r.bus.linkDown();
  r.clock.advance(20000);
  const down = r.app.warnings().filter(w => /went down/.test(w));
  assert.equal(down.length, 1, "exactly one 'went down' message for one outage");
  assert.equal(r.bus.opened, 1, "no sockets are opened while the interface is down");
  assert.equal(r.app.state().can_connected, false);
  assert.equal(r.app.state().can_simulated, false, "this is a lost link, not simulation");
  assert.deepEqual(r.bus.openValves(), ALL, "controllers hold their last command during the outage");

  r.app.invoke("api:stop");                           // operator presses Stop while the link is down
  r.bus.linkUp();
  r.clock.advance(2000);
  assert.equal(r.bus.opened, 2, "one reconnect");
  assert.equal(r.app.state().can_connected, true);
  assert.deepEqual(r.app.state().offline_controllers, []);
  assert.deepEqual(r.bus.openValves(), [], "the Stop pressed during the outage takes effect as soon as the link is back");
});

test("A flapping can0 link does not flood the log and ends up connected", () => {
  const r = rig();
  for (let i = 0; i < 8; i++) {
    r.bus.linkDown();
    r.clock.advance(120);
    r.bus.linkUp();
    r.clock.advance(700);
  }
  r.clock.advance(3000);
  assert.ok(r.app.warnings().filter(w => /went down/.test(w)).length <= 2, "link-lost message must be rate limited");
  assert.equal(r.app.state().can_connected, true);
  assert.deepEqual(r.app.state().offline_controllers, []);
  r.app.invoke("api:valves", { active_ids: [9, 31] });
  r.app.invoke("api:start");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), [9, 31]);
});

test("can0 still down at launch: the app waits, refuses Start, connects when the link comes up", () => {
  const r = rig({ bus: { up: false } });
  let s = r.app.state();
  assert.equal(s.can_connected, false);
  assert.equal(s.can_simulated, false);
  assert.equal(s.can_error.label, "can0 IS DOWN");
  assert.match(r.app.warnings().join("\n"), /can0 exists but is DOWN/);
  assert.equal(r.bus.opened, 0);

  r.app.invoke("api:valves", { active_ids: ALL });
  const res = r.app.invoke("api:start");              // pressed with "can0 IS DOWN" showing
  assert.equal(res.status, "blocked");
  assert.match(res.message, /can-up\.sh/);
  r.clock.advance(5000);
  assert.equal(r.bus.opened, 0, "still nothing opened while down");
  assert.equal(r.app.state().running, false);

  r.bus.linkUp();                                     // can-up.sh is run now
  for (let i = 0; i < 50; i++) {
    r.clock.advance(100);
    assert.deepEqual(r.bus.openValves(), [], "valves opened by themselves when the link came up");
  }
  s = r.app.state();
  assert.equal(s.can_connected, true);
  assert.equal(s.running, false);

  assert.equal(r.app.invoke("api:start").status, "started");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), ALL);
});

// ----------------------------------------------------------------------------
// Normal mode with many valves (the 2026-10-08 fault: all 49 started in the
// same instant made the 12 V supply collapse and controllers 1, 3, 4 restart)
// ----------------------------------------------------------------------------
test("NORMAL MODE: all 49 valves open gradually, stay open until Stop, then close", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  assert.equal(r.app.invoke("api:start").status, "started");

  let prev = 0;
  for (let i = 0; i < 30; i++) {                      // first 3 s, sampled every 100 ms
    r.clock.advance(100);
    const n = r.bus.openValves().length;
    assert.ok(n >= prev, "valves only join during the start");
    assert.ok(n - prev <= 4, `${n - prev} valves opened within 100 ms`);
    prev = n;
  }
  assert.deepEqual(r.bus.openValves(), ALL, "all 49 are open 3 s after Start");
  assert.ok(r.bus.peakStep <= 4, `at most a few valves switch together (saw ${r.bus.peakStep})`);

  for (let i = 0; i < 600; i++) {                     // ten minutes: nothing changes by itself
    r.clock.advance(1000);
    if (i % 60 === 0) assert.deepEqual(r.bus.openValves(), ALL);
  }
  assert.equal(r.app.state().running, true);
  assert.deepEqual(r.app.state().active_ids, ALL);
  for (let id = 1; id <= 5; id++) assert.equal(r.node(id).boots, 1, `controller ${id} never restarted`);

  r.app.invoke("api:stop");
  r.clock.advance(300);
  assert.deepEqual(r.bus.openValves(), [], "Stop closes at once, not gradually");
});

test("NORMAL MODE: a supply that cannot take 49 valves switching together no longer resets the controllers", () => {
  // More than 8 valves switching on within 100 ms collapses the supply and
  // controllers 1, 3 and 4 restart — what the rig did on every Start.
  const r = rig({ bus: { psu: { maxStep: 8 } } });
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(60000);
  assert.equal(r.bus.brownOuts, 0, "the supply collapsed");
  assert.equal(r.app.state().running, true);
  assert.deepEqual(r.bus.openValves(), ALL);
  assert.doesNotMatch(r.app.warnings().join("\n"), /restarted/);
});

test("NORMAL MODE: several valves on one controller, and rows and columns, hold until Stop", () => {
  for (const sel of [range(1, 10), range(22, 28), [3, 10, 17, 24, 31, 38, 45], range(1, 20)]) {
    const r = rig({ bus: { psu: { maxStep: 8 } } });
    r.app.invoke("api:valves", { active_ids: sel });
    r.app.invoke("api:start");
    r.clock.advance(30000);
    assert.deepEqual(r.bus.openValves(), sel);
    assert.equal(r.bus.brownOuts, 0);
    assert.equal(r.app.state().running, true);
  }
});

test("NORMAL MODE: a controller that restarts mid-run gets its valves back a few at a time", () => {
  const r = rig({ bus: { psu: { maxStep: 8, weak: [3] } } });
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(RAMP);
  r.node(3).reset();                                  // one glitch on controller 3
  r.clock.advance(6000);
  assert.equal(r.bus.brownOuts, 0, "its return must not be a 10-valve step");
  assert.equal(r.node(3).boots, 2, "exactly one restart");
  assert.deepEqual(r.bus.openValves(), ALL);
  assert.equal(r.app.state().running, true);
});

test("A supply that cannot hold the load: the run stops, says how many valves were open, and Start is blocked for a while", () => {
  const r = rig({ bus: { psu: { maxValves: 30 } } });   // collapses when the 31st valve opens
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  let waited = 0;
  while (r.app.state().running && waited < 30000) { r.clock.advance(50); waited += 50; }

  const s = r.app.state();
  assert.equal(s.running, false, "the run was stopped");
  const w = r.app.warnings().join("\n");
  // The load is reported as it was when the controller went quiet (31 valves:
  // the supply holds 30), not as it is when the restart message arrives.
  const m = w.match(/restarted \(boot-up message #\d+\)\. It went quiet with (\d+) valves open \((\d+) on this controller\)/);
  assert.ok(m, "restart is logged with the load at the time");
  assert.ok(Number(m[1]) >= 30 && Number(m[1]) <= 33, `reported ${m[1]} valves open, the supply collapses at 31`);
  assert.match(w, /STOPPED with \d+ valves open\. The 12 V supply \(or its wiring\) cannot carry this many valves/);
  r.clock.advance(300);
  assert.deepEqual(r.bus.openValves(), []);

  // Start pressed again straight away: refused, with the reason, and nothing moves.
  const before = r.bus.brownOuts;
  assert.ok(r.app.state().start_blocked_ms > 8000);
  const res = r.app.invoke("api:start");
  assert.equal(res.status, "blocked");
  assert.match(res.message, /Start is blocked for \d+ s: controller \d keeps losing power/);
  r.clock.advance(5000);
  assert.equal(r.app.state().running, false);
  assert.deepEqual(r.bus.openValves(), []);
  assert.equal(r.bus.brownOuts, before, "a refused Start must not touch the valves");

  // After the cool-down the operator may try again, here with fewer valves.
  r.clock.advance(40000);                             // past the cool-down and the restart window
  assert.equal(r.app.state().start_blocked_ms, 0);
  r.app.invoke("api:valves", { active_ids: range(1, 25) });
  assert.equal(r.app.invoke("api:start").status, "started");
  r.clock.advance(RAMP);
  assert.deepEqual(r.bus.openValves(), range(1, 25));
  assert.equal(r.app.state().running, true);
});

test("Start pressed again and again cannot put the controllers through a restart loop", () => {
  // On 2026-10-08 Start arrived about once a second for 12 minutes and the
  // controllers restarted 1055 times. Same supply fault, same hammering:
  const r = rig({ bus: { psu: { maxValves: 30 } } });
  r.app.invoke("api:valves", { active_ids: ALL });
  for (let i = 0; i < 1200; i++) {                    // Start every 100 ms for 2 minutes
    r.app.invoke("api:start");
    r.clock.advance(100);
  }
  for (const id of [1, 3, 4]) {
    assert.ok(r.node(id).boots - 1 <= 16, `controller ${id} restarted ${r.node(id).boots - 1} times in 2 minutes`);
  }
  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("Start while already running changes nothing", () => {
  const r = rig();
  r.app.invoke("api:set_mode", { mode: "natural" });
  r.app.invoke("api:valves", { active_ids: range(1, 5) });
  assert.equal(r.app.invoke("api:start").status, "started");
  r.clock.advance(300);
  const flowBefore = r.app.state().flow_total;
  assert.equal(r.app.invoke("api:start").status, "running");
  assert.equal(r.app.invoke("api:start").status, "running");
  r.clock.advance(100);
  assert.ok(r.app.state().flow_total >= flowBefore);
  assert.equal(r.app.logText().match(/\[SYSTEM\] Started/g).length, 1, "one run, one log line");
});

test("Valves on a controller that is not responding are not shown or counted as open", () => {
  const r = rig({ lateNodes: [1], settleMs: 3000 });  // controller 1 has no power
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(10000);
  const s = r.app.state();
  assert.deepEqual(r.bus.openValves(), range(11, 49));
  for (let v = 1; v <= 10; v++) {
    assert.equal(s.valve_states[v], false, `valve ${v} drawn as open although its controller is dead`);
    assert.equal(s.valve_flow_accum[v], 0, `flow counted for valve ${v}`);
  }
  assert.ok(s.valve_flow_accum[11] > 0);

  r.node(1).powerOn();                                // power arrives mid-run
  r.clock.advance(3000);
  assert.deepEqual(r.bus.openValves(), ALL, "its valves join the run");
});

test("Natural mode with all 49 valves does not switch them all on in the same instant either", () => {
  const r = rig({ bus: { psu: { maxStep: 14 } } });
  r.app.invoke("api:set_mode", { mode: "natural" });
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  const seen = new Set();
  for (let i = 0; i < 300; i++) { r.clock.advance(100); for (const v of r.bus.openValves()) seen.add(v); }
  assert.equal(r.bus.brownOuts, 0);
  assert.equal(seen.size, 49, "every valve took part");
  assert.equal(r.app.state().running, true);
});

// ----------------------------------------------------------------------------
// Supply voltage and MQTT
// ----------------------------------------------------------------------------
test("The controllers' supply voltage is read, shown, and a sag under load is reported", () => {
  const r = rig({ bus: { psu: { volts: 12.1, sagPerValve: 0.05 } }, settleMs: 4000 });
  assert.deepEqual(r.app.state().supply_v, [12.1, 12.1, 12.1, 12.1, 12.1]);

  const idleReads = r.bus.sdoReads;
  r.clock.advance(10000);
  assert.ok(r.bus.sdoReads - idleReads <= 30, "idle polling stays light");

  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(6000);
  const v = r.app.state().supply_v;                   // 49 valves x 0.05 V = 2.45 V of sag
  for (const x of v) assert.ok(Math.abs(x - 9.65) < 0.11, `expected about 9.65 V, got ${x}`);
  assert.match(r.app.warnings().join("\n"), /\[POWER\] Controller \d supply is sagging: \d+\.\d V with \d+ valves open/);

  r.app.invoke("api:stop");
  assert.match(r.app.logText(), /\[POWER\] stopped: lowest supply seen during the run — c1 9\.\d V/);
  assert.equal(r.bus.stats.enobufs, 0, "polling must not crowd the transmit queue");
});

test("MQTT: state and flow are published during a run and the record ends with everything closed", () => {
  const r = rig();
  assert.equal(r.app.state().mqtt_connected, true);
  assert.equal(r.app.state().mqtt_error, null);
  r.app.invoke("api:valves", { active_ids: [1, 49] });
  const res = r.app.invoke("api:start");
  assert.equal(res.mqtt_warning, null);
  r.clock.advance(1000);
  const tila = r.broker.last("venttiilit/tila").split(",");
  assert.equal(tila.length, 49);
  assert.equal(tila[0], "370");
  assert.equal(tila[1], "290");
  assert.equal(tila[48], "370");
  assert.equal(r.broker.last("venttiilit/flow_inc").split(",").length, 49);

  r.app.invoke("api:stop");
  assert.ok(r.broker.last("venttiilit/tila").split(",").every(x => x === "290"), "last state on the broker is all closed");
  assert.ok(r.broker.last("venttiilit/flow_inc").split(",").every(x => Number(x) === 0));
});

test("MQTT: a broker that is down is reported, the run warns, and it reconnects by itself", () => {
  const r = rig({ brokerUp: false });
  let s = r.app.state();
  assert.equal(s.mqtt_connected, false);
  assert.match(s.mqtt_error, /broker not reachable/);
  const res = r.app.invoke("api:start");
  assert.equal(res.status, "started", "MQTT being down does not stop the valves from working");
  assert.match(res.mqtt_warning, /broker not reachable/);
  assert.match(r.app.warnings().join("\n"), /This run is NOT being published/);

  r.broker.start();
  r.clock.advance(6000);
  s = r.app.state();
  assert.equal(s.mqtt_connected, true, "reconnected without restarting the app");
  assert.equal(s.mqtt_error, null);

  r.broker.stop();                                    // broker restarts mid-session
  r.clock.advance(1000);
  assert.equal(r.app.state().mqtt_connected, false);
  assert.match(String(r.app.status.lastPush && r.app.logText()), /Connection lost — retrying/);
  r.broker.start();
  r.clock.advance(6000);
  assert.equal(r.app.state().mqtt_connected, true);
  assert.ok(r.app.warnings().filter(w => /\[MQTT\]/.test(w)).length <= 3, "no log flood while the broker is down");
});

test("MQTT: a missing library is named as such, with the fix", () => {
  const r = rig({ app: { mqttMissing: true } });
  const s = r.app.state();
  assert.equal(s.mqtt_connected, false);
  assert.match(s.mqtt_error, /not installed/);
  assert.match(r.app.warnings().join("\n"), /mqtt library could not be loaded.*npm run setup/);
  r.clock.advance(120000);
  assert.equal(r.app.warnings().filter(w => /mqtt library/.test(w)).length, 1, "said once, not every 30 s");
});

test("NORMAL MODE: the gradual start is spread evenly over the five controllers", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  for (let step = 0; step < 20; step++) {
    r.clock.advance(100);
    const perCtrl = [0, 0, 0, 0, 0];
    for (const v of r.bus.openValves()) perCtrl[Math.floor((v - 1) / 10)]++;
    const spread = Math.max(...perCtrl) - Math.min(...perCtrl);
    assert.ok(spread <= 2, `after ${(step + 1) * 100} ms the controllers carry ${perCtrl.join("/")} valves`);
  }
});

test("Supply-voltage answers are accepted with or without a stated size, and nothing else is mistaken for one", () => {
  const r = rig({ settleMs: 3000 });
  const answer = (cmd, volts, idx = [0x20, 0x50, 0x00]) => {
    const b = Buffer.from([cmd, ...idx, 0, 0, 0, 0]); b.writeFloatLE(volts, 4); return b;
  };
  const deliver = (id, data) => { for (const c of r.bus.channels) c._deliver({ id, data }); };
  const volts = () => r.app.state().supply_v[1];      // controller 2

  deliver(0x582, answer(0x43, 11.5));                 // size stated: 4 bytes
  assert.equal(volts(), 11.5);
  deliver(0x582, answer(0x42, 11.2));                 // size not stated
  assert.equal(volts(), 11.2);

  deliver(0x582, answer(0x4B, 5.0));                  // a 2-byte answer: not a float
  deliver(0x582, answer(0x80, 5.0));                  // an SDO abort
  deliver(0x582, answer(0x43, 5.0, [0x00, 0x10, 0x00])); // another object (1000h)
  deliver(0x582, answer(0x43, NaN));
  deliver(0x582, answer(0x43, 4000));                 // nonsense value
  assert.equal(volts(), 11.2, "only a valid 5020h answer changes the reading");
});
