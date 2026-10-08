# MEQAL Valve Control

Electron desktop app controlling a 7×7 (49-valve) gas manifold over CANopen,
with optional MQTT mirroring. Runs fully even without CAN hardware
(simulation mode), so you can develop and demo on any OS.

## Run

The simplest way on the Raspberry Pi is the **desktop launcher**
(`MEQAL Dev` icon), which runs `scripts/launch.sh`. That script:

1. brings up the CAN bus at the correct bitrate and sends the init frame
   (`scripts/can-up.sh`), then
2. starts the app (native Wayland backend, so no GPU/`gbm_wrapper` log spam).

To run by hand:

```bash
npm install          # installs electron + electron-builder (native CAN/MQTT are optional)
bash scripts/launch.sh   # CAN bring-up + app, exactly like the desktop icon
# or, without touching CAN:
npm start            # launch the app
npm run dev          # launch with DevTools open
```

`npm install` never fails on missing native build tools: `socketcan` and `mqtt`
are **optional**. Without them the app runs in CAN **simulation** mode (status
bar shows `CAN SIM`).

### CAN bring-up (Linux only)

`scripts/can-up.sh` does this for you, but the manual equivalent is:

```bash
sudo ip link set can0 down                              # required: can't re-bitrate a live link
sudo ip link set can0 type can bitrate 125000 restart-ms 100
sudo ip link set can0 up
cansend can0 000#010027F000000000                       # NMT: start all nodes
npm run rebuild:socketcan                               # (once) build the native addon for Electron
```

The bus runs at **125000 bit/s**. A wrong bitrate (e.g. 500000) drives the
controllers into `BUS-OFF` and nothing transmits — the "CAN busy, valves not
opening" symptom. `restart-ms 100` lets the controller auto-recover from
`BUS-OFF`, and `can-up.sh` always takes the link down first so it never trips
`RTNETLINK answers: Device or resource busy`.

### Environment toggles

- `MEQAL_AUTOSTART=1` — select all valves and start continuous flow on launch
  (kiosk / boot-to-running).
- `ELECTRON_OZONE_PLATFORM_HINT=auto` — set by the launcher and npm scripts;
  selects the native Wayland backend and silences the Pi's `gbm_wrapper`
  dma-buf errors.

## Controls

- **Start** — opens the selected valves (or **all 49** if none are selected)
  and runs in the current mode until the cap, **Stop**, or **Emergency Stop**.
  Start and Stop are distinct buttons (no double-press gesture).
- **Normal (all)** — selects every valve and runs continuous flow: opens all
  valves and keeps releasing gas until the per-valve cap, Stop, or Emergency.
- **Emergency Stop** — hard kill: halts, clears the whole selection, and forces
  every valve closed (sends all-closed CAN frames five times).
- **Valve map** — click any single valve to toggle it; **All** selects all 49;
  the **area** dropdown selects a full row or column.
- **Random** — selected valves toggle open/closed at random intervals.
- **Natural (pulse)** — each selected valve pulses: opens until it has delivered
  a random 2–5 dL burst (honouring the hardware minimum open time), pauses for a
  random interval, then reopens — repeating forever, mirroring the Python
  reference's per-valve open/close cycling. Random and Natural are mutually
  exclusive; pressing the active one returns to continuous.
- **Cap/valve (dL)** — a cumulative safety cap. When a valve has delivered this
  many decilitres it closes permanently (turns amber). Works in any mode.
- **Reset Valves / Reset Total / Reset Caps / Export CSV** — as labelled. CSV is
  written to the Desktop (or home dir as fallback).
- **Timer** — optional auto-stop after a fixed duration.

## Architecture

- `src/main.js` — the only place physics lives: the 100 ms control loop, mode
  state machines, CAN PDO output, optional MQTT, and all IPC handlers. It is the
  single source of truth and pushes full state snapshots to the UI.
- `src/preload.js` — context-isolated bridge exposing a small `window.api`.
- `renderer/` — UI only. It sends intent and renders pushed state; it computes
  no flow itself. Controls are wired before charts initialise, and Chart.js is
  guarded, so a chart/CDN failure can never disable the control panel.

## CAN mapping

5 CANopen controllers at node IDs **1–5** (confirmed live on the bus — each
replies with TPDO1/2/3 on `0x180/0x280/0x380 + node`). Each drives 10 outputs
via three RPDOs:

| RPDO  | COB-ID      | Valves (per node) |
|-------|-------------|-------------------|
| RPDO1 | `0x200 + n` | 1–4               |
| RPDO2 | `0x300 + n` | 5–8               |
| RPDO3 | `0x400 + n` | 9–10              |

Each position is a little-endian `UInt16` (`290` closed, `370` open).
Valve *N* (1-indexed): node `floor((N-1)/10)+1`, local output `(N-1)%10`.
**Valve 49 → node 5, RPDO3 `0x405`, slot 0** (this is the valve that the
earlier mapping got wrong).

All TX is paced through a small queue (one frame every ~4 ms) so the Pi's
`mcp251x` hardware TX buffers never overflow (`ENOBUFS` = silently dropped
frames). On connect the app emits the NMT "start all nodes" frame; while idle
it actively re-asserts all-closed; on stop/emergency it sends paced all-closed
sweeps (5× on emergency).
