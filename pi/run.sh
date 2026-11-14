#!/bin/bash
# Starts the Talking Tree patch headless. Run by talkingtree.service at boot; also fine by hand.
# Never touches the network. Waits briefly for the USB sound card and the Arduino, then starts
# anyway: the patch keeps retrying the Arduino on its own, so it can be plugged in later.
cd "$(dirname "$0")"

# Sound card: the first USB audio device, else the Pi's headphone jack.
card=""
for _ in $(seq 20); do
  card=$(awk -F'[][]' '/USB-Audio/ {gsub(/ /, "", $2); print $2; exit}' /proc/asound/cards)
  [ -n "$card" ] && break
  sleep 1
done
[ -z "$card" ] && card=Headphones
dev="plughw:CARD=$card,DEV=0"

# Find that device's number in Pd's list (Pd numbers devices from 1 on the command line).
idx=$(pd -nogui -noprefs -noaudio -alsa -alsaadd "$dev" -listdev -send "pd quit" 2>&1 |
  awk -v d="$dev" '/audio output devices/ {out=1} out && index($0, d) {print $1 + 1; exit}')
idx=${idx:-1}

# Arduino: Unos show up as ttyACM*, most clones as ttyUSB*.
port=""
for _ in $(seq 10); do
  port=$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | head -n 1)
  [ -n "$port" ] && break
  sleep 1
done
port=${port:-/dev/ttyACM0}

echo "talkingtree: audio $dev (device $idx), Arduino $port"
exec pd -nogui -noprefs -rt -alsa -alsaadd "$dev" -audiooutdev "$idx" -noadc -outchannels 2 \
  -r 44100 -audiobuf 80 -nomidi -send "tt_port symbol $port" talkingtree.pd
