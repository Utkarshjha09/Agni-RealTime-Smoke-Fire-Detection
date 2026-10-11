#!/usr/bin/env bash
# Deploy the Agni rover service to a Raspberry Pi over SSH.
#
#     ./deploy.sh pi@192.168.1.50
#     ./deploy.sh pi@raspberrypi.local --model ../model/weights/best_nano_111_ncnn_model
#     ./deploy.sh pi@192.168.1.50 --no-deps          # code only, skip pip/apt
#
# It copies the service and the exported model, installs the dependencies,
# writes rover.env with a generated token on the first run, installs a systemd
# unit so the rover comes up at boot, and then checks the service actually
# answers. It finishes by printing the three values to type into the app.
#
# Re-running is safe. An existing rover.env is never overwritten, so your token
# and your motor settings survive every later deploy.
#
# Needs: ssh and tar on this machine (Git Bash on Windows has both), and an SSH
# key or password on the Pi. Nothing is installed on this machine.

set -euo pipefail

# Git Bash rewrites arguments that look like Unix paths into Windows ones, which
# would turn the Pi's /home/pi/agni into something like C:/Program Files/Git/home/...
# inside the remote commands below. Harmless everywhere else.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET=""
REMOTE_DIR=""
MODEL_SRC="$HERE/../model/weights/best_nano_111_ncnn_model"
INSTALL_DEPS=1
INSTALL_SERVICE=1

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) REMOTE_DIR="${2:-}"; shift 2 ;;
    --model) MODEL_SRC="${2:-}"; shift 2 ;;
    --no-model) MODEL_SRC=""; shift ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$TARGET" ] || die "give one target, not '$TARGET' and '$1'"; TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || die "usage: ./deploy.sh user@host [--model PATH] [--dir PATH]"
case "$TARGET" in *@*) ;; *) TARGET="pi@$TARGET" ;; esac
REMOTE_USER="${TARGET%%@*}"
REMOTE_HOST="${TARGET#*@}"
[ -n "$REMOTE_DIR" ] || REMOTE_DIR="/home/$REMOTE_USER/agni"

SERVICE_FILES="rover_server.py security.py fire_detector.py range_sensor.py verify_rover.py requirements.txt rover.env.example agni-rover.service README.md"
for name in $SERVICE_FILES; do
  [ -f "$HERE/$name" ] || die "missing $name next to this script"
  # An empty source file once reached the Pi this way, and the rover then exited
  # silently at boot with nothing to run. Never send one.
  [ -s "$HERE/$name" ] || die "$name is empty here; refusing to deploy it. Save the file and try again."
done

if [ -n "$MODEL_SRC" ]; then
  [ -e "$MODEL_SRC" ] || die "model not found: $MODEL_SRC
Export one first:  cd ../model && python export.py --weights weights/best_nano_111.pt
Or deploy without it (the Pi then downloads pretrained weights):  --no-model"
  MODEL_SRC="$(cd "$(dirname "$MODEL_SRC")" && pwd)/$(basename "$MODEL_SRC")"
  MODEL_NAME="$(basename "$MODEL_SRC")"
fi

SSH="ssh -o ConnectTimeout=10 $TARGET"

say "Checking $TARGET"
$SSH true || die "cannot reach $TARGET over SSH.
Enable SSH on the Pi (sudo raspi-config > Interface Options > SSH) and confirm
the address with 'ping $REMOTE_HOST'."
PI_MODEL="$($SSH 'cat /proc/device-tree/model 2>/dev/null | tr -d "\0"' || true)"
printf '   %s\n' "${PI_MODEL:-unknown board}"

say "Copying the service to $REMOTE_DIR"
$SSH "mkdir -p '$REMOTE_DIR/model'"
tar -C "$HERE" -cf - $SERVICE_FILES | $SSH "tar -C '$REMOTE_DIR' -xf -"
# Check what arrived, byte for byte. A copy once delivered every name and date
# with no content, and only a restart revealed it.
LOCAL_SUMS="$(cd "$HERE" && md5sum $SERVICE_FILES | sed 's/ \*/  /')"
REMOTE_SUMS="$($SSH "cd '$REMOTE_DIR' && md5sum $SERVICE_FILES")"
[ "$LOCAL_SUMS" = "$REMOTE_SUMS" ] || die "the files on the Pi do not match this computer after copying:
$(diff <(echo "$LOCAL_SUMS") <(echo "$REMOTE_SUMS") || true)
Nothing was restarted. Run deploy.sh again."
$SSH "cd '$REMOTE_DIR' && python3 -m py_compile rover_server.py security.py fire_detector.py range_sensor.py" \
  || die "rover_server.py does not compile on the Pi; not restarting it."
printf '   service files copied and verified\n'

if [ -n "$MODEL_SRC" ]; then
  say "Copying the model ($MODEL_NAME)"
  # Piping tar keeps the NCNN folder intact and needs no rsync on Windows.
  tar -C "$(dirname "$MODEL_SRC")" --exclude=__pycache__ -cf - "$MODEL_NAME" \
    | $SSH "tar -C '$REMOTE_DIR/model' -xf -"
  $SSH "du -sh '$REMOTE_DIR/model/$MODEL_NAME' | cut -f1" | sed 's/^/   /'
fi

if [ "$INSTALL_DEPS" -eq 1 ]; then
  say "Installing dependencies (several minutes on a first run)"
  $SSH "set -e
    sudo apt-get update -qq
    sudo apt-get install -y python3-picamera2 python3-opencv python3-pip python3-libcamera
    cd '$REMOTE_DIR'
    # CPU-only PyTorch first. The default aarch64 wheel on PyPI pulls in about
    # 4 GB of NVIDIA CUDA libraries that a Pi has no GPU to use; with torch
    # already present, the requirements below leave it alone.
    python3 -m pip install --break-system-packages --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu torch torchvision
    # --no-cache-dir: a cache of every downloaded wheel cost 3.3 GB of SD card.
    python3 -m pip install --break-system-packages --no-cache-dir -r requirements.txt"
else
  printf '\n== Skipping dependencies (--no-deps)\n'
fi

say "Configuring rover.env"
# The first deploy generates the shared secret. Later deploys leave the file
# alone so the token the app already holds keeps working.
MODEL_ENV=""
[ -n "$MODEL_SRC" ] && MODEL_ENV="$REMOTE_DIR/model/$MODEL_NAME"
$SSH "set -e
  cd '$REMOTE_DIR'
  if [ ! -f rover.env ]; then
    cp rover.env.example rover.env
    token=\$(openssl rand -hex 16)
    sed -i \"s|^ROVER_TOKEN=.*|ROVER_TOKEN=\$token|\" rover.env
    sed -i \"s|^MODEL_PATH=.*|MODEL_PATH=$MODEL_ENV|\" rover.env
    chmod 600 rover.env
    echo '   rover.env created with a new token'
  else
    if [ -n '$MODEL_ENV' ]; then
      sed -i \"s|^MODEL_PATH=.*|MODEL_PATH=$MODEL_ENV|\" rover.env
    fi
    echo '   rover.env already exists, keeping your token and motor settings'
  fi"

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  say "Installing the systemd service"
  $SSH "set -e
    cd '$REMOTE_DIR'
    sed -e 's|/home/pi/agni|$REMOTE_DIR|g' -e 's|^User=pi\$|User=$REMOTE_USER|' -e 's|^Group=pi\$|Group=$REMOTE_USER|' \
      agni-rover.service | sudo tee /etc/systemd/system/agni-rover.service > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable agni-rover > /dev/null 2>&1
    sudo systemctl restart agni-rover"
  printf '   agni-rover enabled and started\n'
else
  printf '\n== Skipping the service (--no-service)\n'
fi

say "Checking the rover answers"
PORT="$($SSH "grep -E '^HTTP_PORT=' '$REMOTE_DIR/rover.env' | cut -d= -f2" || true)"
[ -n "$PORT" ] || PORT=8000
STATUS=""
# The detector loads weights on startup, which takes a few seconds on a Pi.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  STATUS="$($SSH "curl -sf --max-time 3 http://127.0.0.1:$PORT/status" || true)"
  [ -n "$STATUS" ] && break
  sleep 3
done

if [ -z "$STATUS" ]; then
  printf '   the service did not answer on port %s. Its log:\n\n' "$PORT"
  $SSH "sudo journalctl -u agni-rover -n 40 --no-pager" || true
  die "rover not answering -- fix the error above, then re-run: $SSH 'sudo systemctl restart agni-rover'"
fi
printf '   %s\n' "$STATUS"

IP="$($SSH "hostname -I | awk '{print \$1}'" | tr -d '\r')"
TOKEN="$($SSH "grep -E '^ROVER_TOKEN=' '$REMOTE_DIR/rover.env' | cut -d= -f2" | tr -d '\r')"

cat <<SUMMARY

== Deployed.

Open the app, go to Settings, and enter exactly these:

   Camera frame URL       http://$IP:$PORT/frame.jpg
   Control WebSocket URL  ws://$IP:$PORT/control
   Access token           $TOKEN

The phone must be on the same Wi-Fi network as the Pi.

Motors are still disabled. Once you have checked the driver pins against the
BCM numbers at the top of rover_server.py, turn them on:

   $SSH "sed -i 's/^MOTOR_OUTPUT=0/MOTOR_OUTPUT=1/' $REMOTE_DIR/rover.env && sudo systemctl restart agni-rover"

Watch the log while you drive:

   $SSH "journalctl -u agni-rover -f"
SUMMARY
