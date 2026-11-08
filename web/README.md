# Talking Tree: web version

Touch-and-hold tree rings play the 2019 Talking Tree sonification in the browser.

## Run it locally

The page fetches its audio and data, so it needs a local web server (opening `index.html` directly won't work):

```
cd web
python -m http.server 8000
```

Then open http://localhost:8000.

## Engines

- **RNBO export (the real one):** put the RNBO Web Export output in `web/export/`, so that `web/export/patch.export.json` exists.
  The page loads the matching @rnbo/js version and uses the device. Param and buffer names must match `rnbo/PATCH-SPEC.md`.
- **Preview:** until that file exists, the page uses a small Web Audio engine that follows the same spec,
  so it can be tested and shown before the export is ready. The status line says which engine is running.

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
