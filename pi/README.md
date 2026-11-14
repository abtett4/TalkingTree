# Talking Tree: Pure Data version

This version runs on a Raspberry Pi 3 B+ inside the tree. It boots straight into the piece with no screen and no network.
It behaves the same as the web version. Both follow [`docs/BEHAVIOR.md`](../docs/BEHAVIOR.md).

The patch is vanilla Pure Data. The one external is [comport], which reads the Arduino.

```
pi/
  talkingtree.pd     open this one
  lib/               the parts (tt-*.pd), one job each
  audio/             leaf2.wav, log3.wav (mono, 44.1 kHz, channel 1 of the 2018 recordings)
  data/              years.txt, range.txt (made from web/data/treedata.json by tools/make_data.py)
  run.sh             starts Pd headless (used at boot)
  install.sh         one-time Pi setup
```

## Try it on a laptop

1. Install vanilla Pure Data (0.51 or newer) from [puredata.info](https://puredata.info/downloads/pure-data).
   Purr Data may open it too, but vanilla matches what runs on the Pi.
2. Open `pi/talkingtree.pd`. Audio switches on by itself.
3. Click the five rings, or press keys 1 to 5 with the patch window focused. The strength slider stands in for
   how hard the ring is held, which sets the delay time.

To use the real tree, install comport (in Pd: Help → Find externals → `comport`), plug in the Arduino, and click
the message box with its port (COM3 or COM4 on Windows; check Device Manager).

The patch handles up to 18 rings (1990 to 2007), so a bigger tree only needs the Arduino sketch to print more
values per line. Ring N plays year 1990 + N - 1. The test panel shows the 2019 tree's five rings.

Settings live in `lib/tt-params.pd`. Edit the numbers in the message box and click it to hear the change.

## How it is put together

| Part | Job |
| --- | --- |
| `tt-params` | All settings, with the defaults from BEHAVIOR.md |
| `tt-load` | Loads the sounds and the data, then turns audio on |
| `tt-serial` | Reads `lag ring1 ring2 …` lines from the Arduino, with any number of rings. If nothing arrives for 5 s, it reopens the port |
| `tt-touch`, `tt-ring` | Works out touches and releases, handling releases first. The strongest held ring sets the delay time |
| `tt-year` | Looks up the touched ring's year and turns it into rate, filter cutoffs, loudness, echo and sound |
| `tt-player~`, `tt-voice~` | The wandering loop player, with two voices crossfading over 5 ms on every jump |
| `tt-engine~`, `tt-lowpass~` | Dry path, delay with feedback, and filters |

## Set up the Pi

You need a Raspberry Pi OS (Lite is enough) SD card, a USB sound card and speakers, and the Arduino on USB.
Setup needs the network once. After that the piece never uses it.

1. Plug in the USB sound card and the Arduino, then boot the Pi and log in.
2. Get this repository and run the installer:

   ```
   sudo apt-get install -y git
   git clone https://github.com/abtett4/TalkingTree.git
   bash TalkingTree/pi/install.sh
   ```

3. `sudo reboot`. The piece starts about 20 seconds after power on.

Check it is running with `journalctl -u talkingtree -f`. Each touch prints its year there.

**Offline check.** Unplug the network (or turn off Wi-Fi), pull the power, plug it back in, and touch a ring.
Nothing in the start-up waits for the network.

**What the start script does.** It waits up to 20 s for a USB sound card. Without one it falls back to the
headphone jack, which is noisy. It waits up to 10 s for the Arduino. If the Arduino is missing, the patch keeps
retrying, so it can be plugged in later. If Pd ever exits, it restarts after 3 s.

**Optional, for exhibitions.** Pulling the power can eventually corrupt an SD card. Once everything works, turn on
the read-only overlay (`sudo raspi-config` → Performance Options → Overlay File System). Turn it off again before
updating.

## Changing the data

`data/years.txt` is built from `web/data/treedata.json`. After the data changes, run `python3 pi/tools/make_data.py`.
