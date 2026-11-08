# Talking Tree: web version

Touch-and-hold tree rings play the 2019 Talking Tree sonification in the browser.

## Run it locally

The page fetches its audio and data, so it needs a local web server (opening `index.html` directly won't work):

```
cd web
python -m http.server 8000
```

Then open http://localhost:8000.

## How it works

`app.js` rebuilds the 2019 Max/MSP patch in plain Web Audio, with no libraries or build step. A looping sample player wanders through the sound file, and a feedback delay with a lowpass filter sits on top. The tree-ring value for the touched year sets the playback rate and the filter cutoff. `docs/BEHAVIOR.md` describes the behaviour independent of any tool, and the Raspberry Pi version (Pure Data) will follow it too.

## Inputs

- **Mouse or touch:** press and hold a ring. Holding longer acts like a firmer touch (700 up to 2000), which lengthens the delay.
- **Arduino:** "Connect Arduino" uses Web Serial (Chrome or Edge, desktop). It reads the unchanged 2019 sketch
  (`TalkingTreeScript.ino`) at 9600 baud.
- **Demo:** plays random touches, one ring at a time.

## Files

| Path | What |
| --- | --- |
| `audio/*.mp3` | The six 2019 sound files: left channel (what `groove~` played), 44.1 kHz, 128 kbps |
| `data/treedata.json` | Growth index for 1990 to 2007, the values in the 2019 patch. Source attribution pending |
| `app.js` | Host page: engines, inputs, tree drawing |
