#!/bin/bash
# One-time setup on the Raspberry Pi (needs the network this once):
#   bash pi/install.sh
# Installs Pure Data and comport, then makes the piece start on every boot.
set -e
dir="$(cd "$(dirname "$0")" && pwd)"
user="$(id -un)"

sudo apt-get update
sudo apt-get install -y puredata-core pd-comport
sudo usermod -aG audio,dialout "$user"

sed -e "s|USER|$user|" -e "s|DIR|$dir|" "$dir/talkingtree.service" |
  sudo tee /etc/systemd/system/talkingtree.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable talkingtree.service

echo
echo "Done. It starts on the next boot (sudo reboot), or now with: sudo systemctl start talkingtree"
echo "Watch it with: journalctl -u talkingtree -f"
