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
  r.clock.advance(500);
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
  r.clock.advance(1000);
  assert.deepEqual(r.bus.openValves(), ALL);

  r.app.invoke("api:stop");
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), []);
});

test("FAULT valves dead: a controller that resets while running rejoins and obeys again", () => {
  const r = rig();
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");
  r.clock.advance(1000);
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
  r.clock.advance(1000);
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
  r.clock.advance(1000);

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
  r.clock.advance(1000);

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

test("Without the socketcan module the app still runs in simulation", () => {
  const r = rig({ app: { socketcanMissing: true } });
  const s = r.app.state();
  assert.equal(s.can_connected, false);
  assert.equal(s.can_simulated, true);
  r.app.invoke("api:start");
  r.clock.advance(1000);
  assert.equal(r.app.state().running, true);
  assert.ok(r.app.state().flow_total > 0);
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
  r.clock.advance(2000);
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
  // Controller 2: output overload 0xF002 on channel 7 (open circuit) = valve 17.
  r.bus.nodeTransmit(r.node(2), 0x082, Buffer.from([0x02, 0xF0, 0x01, 0x07, 0x10, 0x00, 0x00, 0x00]));
  const w = r.app.warnings().join("\n");
  assert.match(w, /Controller 3 reports a fault: supply voltage out of range \(UNDERVOLTAGE\)/);
  assert.match(w, /Controller 2 reports a fault: output open\/short circuit on output 7 = valve 17/);
  assert.match(w, /raw 0030010040000000/);
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

test("A simulated run never turns into real open valves when can0 appears", () => {
  const r = rig({ bus: { present: false } });
  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");                          // "running" in simulation
  r.clock.advance(5000);

  r.bus.present = true;                               // the interface shows up mid-run
  for (let i = 0; i < 120; i++) {                     // two more minutes of the simulated run
    r.clock.advance(1000);
    assert.deepEqual(r.bus.openValves(), [], "a real valve opened during a simulated run");
  }
  assert.equal(r.bus.opened, 0, "must not connect while a simulated run is in progress");

  r.app.invoke("api:stop");
  r.clock.advance(35000);
  assert.equal(r.app.state().can_connected, true, "connects once idle");
  assert.deepEqual(r.bus.openValves(), []);
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
  r.clock.advance(1000);
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
  r.clock.advance(1000);

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
  r.clock.advance(1000);

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

test("can0 still down at launch: the app waits, connects when it comes up, and never starts valves on its own", () => {
  const r = rig({ bus: { up: false } });
  let s = r.app.state();
  assert.equal(s.can_connected, false);
  assert.equal(s.can_simulated, false, "hardware is present: show NO CAN, not CAN SIM");
  assert.match(r.app.warnings().join("\n"), /can0 exists but is DOWN/);
  assert.equal(r.bus.opened, 0);

  r.app.invoke("api:valves", { active_ids: ALL });
  r.app.invoke("api:start");                          // pressed with NO CAN showing
  r.clock.advance(5000);
  assert.equal(r.bus.opened, 0, "still nothing opened while down");

  r.bus.linkUp();                                     // can-up.sh is run now
  for (let i = 0; i < 50; i++) {
    r.clock.advance(100);
    assert.deepEqual(r.bus.openValves(), [], "valves opened by themselves when the link came up");
  }
  s = r.app.state();
  assert.equal(s.can_connected, true);
  assert.equal(s.running, false, "the run that had no hardware is stopped, not continued on real valves");
  assert.match(r.app.warnings().join("\n"), /CAN came up during a run that had no hardware/);

  r.app.invoke("api:start");                          // now the operator starts for real
  r.clock.advance(500);
  assert.deepEqual(r.bus.openValves(), ALL);
});
