#!/usr/bin/env bash
# ============================================================================
# MEQAL — set up (or repair) a checkout so the dashboard runs for real
# ----------------------------------------------------------------------------
# One command, safe to run as often as you like:
#       npm run setup          (or: bash scripts/setup.sh)
#
#   1. checks the system tools and services the dashboard needs
#   2. installs the npm packages if they are not there yet
#   3. makes sure mqtt and socketcan really load inside the app, and restores
#      them from vendor/ when a download or a build failed
#   4. points the desktop icon at this folder
#
# It never touches the CAN bus and never starts the app.
# ============================================================================
set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$DIR" || exit 1
PROBLEMS=0

echo "== 1/4 system =="
need() {   # need <command> <how to get it>
  if command -v "$1" >/dev/null 2>&1; then
    printf '  %-10s ok\n' "$1"
  else
    printf '  %-10s MISSING  ->  %s\n' "$1" "$2"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}
need node    "sudo apt install -y nodejs npm"
need npm     "sudo apt install -y nodejs npm"
need python3 "sudo apt install -y python3     (the Natural (2-5dl) mode runs a Python script)"
need ip      "sudo apt install -y iproute2"
need cansend "sudo apt install -y can-utils"

if ip link show can0 >/dev/null 2>&1; then
  printf '  %-10s present\n' "can0"
else
  printf '  %-10s NOT PRESENT  ->  check the CAN board and the mcp2515 line in /boot/firmware/config.txt\n' "can0"
  PROBLEMS=$((PROBLEMS + 1))
fi

if sudo -n true 2>/dev/null; then
  printf '  %-10s passwordless (needed to bring can0 up)\n' "sudo"
else
  printf '  %-10s asks for a password  ->  the launcher cannot bring can0 up by itself\n' "sudo"
  PROBLEMS=$((PROBLEMS + 1))
fi

if systemctl is-active --quiet mosquitto 2>/dev/null; then
  printf '  %-10s running\n' "mosquitto"
else
  printf '  %-10s NOT RUNNING  ->  sudo apt install -y mosquitto && sudo systemctl enable --now mosquitto\n' "mosquitto"
  PROBLEMS=$((PROBLEMS + 1))
fi

echo "== 2/4 npm packages =="
if [ -x node_modules/electron/dist/electron ]; then
  echo "  already installed"
else
  # The check in step 3 runs after this by itself (postinstall) and again below.
  npm install --no-audit --no-fund || echo "  npm install reported a problem — step 3 says what is missing"
fi

echo "== 3/4 runtime libraries =="
node scripts/ensure-deps.js || PROBLEMS=$((PROBLEMS + 1))

echo "== 4/4 desktop icon =="
if [ -d "$HOME/Desktop" ]; then
  sed -e "s#^Exec=.*#Exec=$DIR/scripts/launch.sh#" -e "s#^Path=.*#Path=$DIR/scripts/#" \
      scripts/MEQAL-Dev.desktop > "$HOME/Desktop/MEQAL-Dev.desktop"
  chmod +x "$HOME/Desktop/MEQAL-Dev.desktop" scripts/launch.sh scripts/can-up.sh
  echo "  $HOME/Desktop/MEQAL-Dev.desktop now starts $DIR"
else
  echo "  no Desktop folder — start the app with: bash $DIR/scripts/launch.sh"
fi

echo
if [ "$PROBLEMS" -eq 0 ]; then
  echo "READY. Start the dashboard from the MEQAL Dev desktop icon."
else
  echo "NOT READY: $PROBLEMS problem(s) above. Fix them and run this again."
fi
exit "$PROBLEMS"
