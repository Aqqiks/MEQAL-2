#!/usr/bin/env bash
# ============================================================================
# MEQAL — desktop launcher
# ----------------------------------------------------------------------------
# What the desktop icon runs. It:
#   1. Brings up the CAN bus (can-up.sh) at the correct bitrate + init frame.
#   2. Launches the Electron app.
#
# CAN setup is best-effort: if it fails (no hardware, no sudo) the app still
# starts in simulation mode. All output is logged so a launch from the desktop
# (no terminal attached) can still be diagnosed.
# ============================================================================
set -u

# Use the native Wayland Ozone backend when on a Wayland session. This avoids
# the X11/XWayland GBM path that spams gbm_wrapper "Failed to export buffer to
# dma_buf" on the Pi's vc4/v3d driver. Must be set before Electron starts.
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

# Resolve the app root (this script lives in <root>/scripts/).
DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOG="${HOME}/.meqal-valve.log"

{
  echo "==== MEQAL launch $(date '+%Y-%m-%d %H:%M:%S') ===="

  # 1) CAN bring-up (never fatal to the launch).
  bash "$DIR/scripts/can-up.sh" || echo "[launch] CAN setup skipped/failed — continuing in simulation."

  # 2) Pick the Electron binary that ships with the app.
  ELECTRON="$DIR/node_modules/electron/dist/electron"
  if [ ! -x "$ELECTRON" ]; then
    ELECTRON="$DIR/node_modules/.bin/electron"
  fi
  echo "[launch] starting: $ELECTRON $DIR"
} >>"$LOG" 2>&1

cd "$DIR" || exit 1
exec "$ELECTRON" "$DIR" "$@" >>"$LOG" 2>&1
