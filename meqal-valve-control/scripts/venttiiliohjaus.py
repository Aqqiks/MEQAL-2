#!/usr/bin/env python3

import time
import csv
import signal
import sys
#
# ATTENTION!!!!
# Here you can find and change the run time for Valve
# simulation, our default is 5 seconds

# ----------------------------------------------------------------------------
# CAN + MQTT REMOVED ON PURPOSE
# ----------------------------------------------------------------------------
# The CAN bus output and the MQTT publishing that used to live here have been
# taken out. The Electron main process (src/main.js) is now the single owner of
# the CAN bus and the MQTT mirror. This script's only job is to decide, from the
# per-valve CSV timing profile, which valves should be OPEN at each instant, and
# to print that set to stdout, one line per refresh:
#
#       OPEN:<comma-separated, 1-indexed valve ids>     (empty list => all shut)
#
# main.js reads those lines and drives the real hardware. Because of this the
# script no longer imports `can` or `paho.mqtt` — it only needs the Python
# standard library and venttiilit.csv next to it.
# ----------------------------------------------------------------------------

# Here is our CSV file for calculation of air/methane
# input per valve open/close cycle
CSV_FILE = "venttiilit.csv"
RUN_DURATION = 5

# Here is the raw values for closed and open valve positions. Kept for parity
# with the hardware layer in main.js (which maps OPEN -> RAW_OPEN); this script
# itself no longer emits raw CAN values.
RAW_CLOSED = 290
RAW_OPEN = 370

# Here is the mininum open time for the valves,
# this is meant to prevent too rapid switching,
# which can be harmful for the hardware
MIN_OPEN_TIME = 0.4
REFRESH_INTERVAL = 0.05  # Set refresh interval of 50ms

# Here we have the total number of valves and grid
# size, grid size is used to determine the layout of
# the valves and which ones are active based on the
# area parameter
NUM_VALVES = 49
GRID_SIZE = 7

# ---------------- AREA ----------------
area = int(sys.argv[1]) if len(sys.argv) > 1 else 12

radius = (area / 2) / 2
center = (GRID_SIZE - 1) / 2

active_valves = set()

for v in range(NUM_VALVES):
    x = v % GRID_SIZE
    y = v // GRID_SIZE
    if abs(x - center) <= radius and abs(y - center) <= radius:
        active_valves.add(v)

print("ACTIVE VALVES:", sorted(active_valves), flush=True)

state = [False] * NUM_VALVES
running = True

# ---------------- SIGNALS ----------------
def emergency_handler(sig, frame):
    global running
    print("[EMERGENCY] Stop signal received", flush=True)
    running = False

signal.signal(signal.SIGTERM, emergency_handler)
signal.signal(signal.SIGINT, emergency_handler)
signal.signal(signal.SIGUSR1, emergency_handler)

# ---------------- OUTPUT (replaces CAN/MQTT) ----------------
def emit_open():
    # Print the 1-indexed ids of every valve that is open right now. main.js
    # owns the CAN bus and turns this set into the actual RPDO frames.
    open_ids = [i + 1 for i in range(NUM_VALVES) if state[i]]
    print("OPEN:" + ",".join(str(i) for i in open_ids), flush=True)

# ---------------- CSV ----------------
valve_profile = {}

with open(CSV_FILE, newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        idx = int(row["Venttiili"]) - 1
        valve_profile[idx] = {
            "open": float(row["Aukioloaika(s)"]),
            "close": float(row["Kiinnioloaika(s)"])
        }

next_switch = {}
now = time.time()

for v in range(NUM_VALVES):
    next_switch[v] = now + valve_profile[v]["close"]

start_time = time.time()

# ---------------- MAIN LOOP ----------------
try:
    while running and (time.time() - start_time < RUN_DURATION):

        now = time.time()

        for v in range(NUM_VALVES):
            if v not in active_valves:
                state[v] = False

        for v in active_valves:
            if now >= next_switch[v]:
                state[v] = not state[v]

                if state[v]:
                    next_switch[v] = now + max(
                        valve_profile[v]["open"],
                        MIN_OPEN_TIME
                    )
                else:
                    next_switch[v] = now + valve_profile[v]["close"]

        emit_open()

        time.sleep(REFRESH_INTERVAL)

finally:
    print("[INFO] Closing all valves safely...", flush=True)

    running = False
    for v in range(NUM_VALVES):
        state[v] = False

    # Final all-closed line so main.js shuts every valve, then signal completion.
    emit_open()
    print("DONE", flush=True)
