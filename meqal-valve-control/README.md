# MEQAL Valve Control

Electron desktop app controlling a 7×7 (49-valve) gas manifold over CANopen,
with optional MQTT mirroring. Runs fully even without CAN hardware
(simulation mode), so you can develop and demo on any OS.

## Run

```bash
npm install          # installs electron + electron-builder (native CAN/MQTT are optional)
npm start            # launch the app
npm run dev          # launch with DevTools open
```

`npm install` never fails on missing native build tools: `socketcan` and `mqtt`
are **optional**. Without them the app runs in CAN **simulation** mode (status
bar shows `CAN SIM`).

### Enabling real CAN (Linux only)

```bash
sudo ip link set can0 up type can bitrate 500000   # bring up the interface
npm run rebuild:socketcan                           # build the native addon for Electron
npm start
```

## Controls

- **Start** — runs the system with the selected valves. **Press Start twice
  quickly (within 600 ms) to stop.** A dedicated **Stop** button is also there.
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

5 controllers, 10 valves each (last one has 9). Per controller:
`0x200+n` carries valves 1–4, `0x300+n` valves 5–8, `0x400+n` valves 9–10, each
position a little-endian UInt16 (`290` closed, `370` open).
