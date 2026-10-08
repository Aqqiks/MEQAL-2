#!/usr/bin/env bash
# ============================================================================
# MEQAL — CAN interface bring-up
# ----------------------------------------------------------------------------
# Brings can0 up at the bitrate the valve controllers actually use (125000)
# and sends the CANopen NMT "start all nodes" init frame.
#
# Why this exists:
#   * `sudo ip link set can0 up type can bitrate ...` fails with
#       "RTNETLINK answers: Device or resource busy"
#     whenever the link is already administratively UP. You cannot change the
#     bitrate of a live CAN link — so we ALWAYS take it down first.
#   * The bench hardware runs at 125000, not the 500000 some notes mention.
#     A wrong bitrate puts the controller into BUS-OFF and nothing transmits
#     ("CAN busy, valves not opening").
#   * restart-ms 100 lets the controller auto-recover from BUS-OFF.
#   * The init frame mirrors the proven manual command:
#       cansend can0 000#010027F000000000
#
# Safe to run repeatedly. Needs passwordless sudo for `ip` (already configured
# on this Pi). If can0 doesn't exist, it exits 0 so the app still launches in
# simulation mode.
# ============================================================================
set -u

IFACE="${CAN_IFACE:-can0}"
BITRATE="${CAN_BITRATE:-125000}"
INIT_FRAME="${CAN_INIT_FRAME:-000#010027F000000000}"

# Re-exec under sudo if we are not root (ip link needs privilege).
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then
    exec sudo -n "$0" "$@"
  else
    echo "[can-up] no passwordless sudo — skipping CAN setup (app will run in simulation)." >&2
    exit 0
  fi
fi

# If the interface is absent, there is nothing to configure.
if ! ip link show "$IFACE" >/dev/null 2>&1; then
  echo "[can-up] interface $IFACE not present — skipping (simulation mode)."
  exit 0
fi

# 1) Always take the link down first (clears "Device or resource busy").
ip link set "$IFACE" down 2>/dev/null || true

# 2) Configure type/bitrate while down, with auto bus-off recovery.
if ! ip link set "$IFACE" type can bitrate "$BITRATE" restart-ms 100; then
  echo "[can-up] failed to set bitrate $BITRATE on $IFACE" >&2
  exit 1
fi

# 3) Bring it up.
if ! ip link set "$IFACE" up; then
  echo "[can-up] failed to bring $IFACE up" >&2
  exit 1
fi
echo "[can-up] $IFACE up @ ${BITRATE} bit/s (restart-ms 100)"

# 4) Send the CANopen NMT "start all nodes" init frame, if cansend is present.
if command -v cansend >/dev/null 2>&1; then
  cansend "$IFACE" "$INIT_FRAME" 2>/dev/null \
    && echo "[can-up] sent init frame $INIT_FRAME" \
    || echo "[can-up] warning: init frame send failed" >&2
fi

exit 0
