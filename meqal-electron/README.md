# MEQAL Valve Control — Electron App

Desktop app converted from Flask → Electron. No Python or web server required.

## Project Structure

```
meqal-electron/
├── package.json
├── src/
│   ├── main.js        ← Electron main process (replaces app.py + backend.py)
│   └── preload.js     ← IPC bridge (replaces Flask REST API)
└── renderer/
    ├── index.html     ← Dashboard UI
    └── renderer.js    ← Frontend controller (replaces renderer.js in Flask)
```

## Quick Start

```bash
cd meqal-electron
npm install
npm start
```

## Build Distributable

```bash
# Linux AppImage
npm run build:linux

# Windows installer
npm run build:win

# Both
npm run build
```

Output goes to `dist/`.

## Hardware

### CAN Bus
- Requires `socketcan` npm package and a `can0` interface on Linux
- If CAN is not available, the app runs in simulation mode (no crash)
- To install: `npm install socketcan`
- If Electron fails to load the native addon, rebuild it for Electron with:

```bash
cd meqal-electron
npx electron-rebuild -f -w socketcan
```

### MQTT
- Requires a broker running on `localhost:1883`
- App connects on startup; silently skips if broker is unavailable
- Topics: `valves/flow_inc`, `valve/state`

## API → IPC Mapping

| Flask route          | Electron IPC channel |
|----------------------|----------------------|
| GET  /api/state      | api:state            |
| POST /api/start      | api:start            |
| POST /api/stop       | api:stop             |
| POST /api/emergency  | api:emergency        |
| POST /api/valves     | api:valves           |
| POST /api/reset_total| api:reset_total      |
| POST /api/csv        | api:csv              |

## CSV Export
Saves to `~/Desktop/meqal_flow_<timestamp>.csv` with columns:
`timestamp, flow_total, active_valve_count`
