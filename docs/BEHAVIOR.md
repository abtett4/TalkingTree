# Talking Tree: sound behaviour

What the piece does, independent of any tool. Traced from the 2019 Max/MSP patch
(`TalkingTreePatch.maxpat`, Max 7.3.5), which stays in the repo unchanged. The web version
(`web/app.js`, Web Audio) follows this, and the planned Raspberry Pi version (Pure Data) should too.

## Input

The Arduino sketch (`TalkingTreeScript.ino`) reads five capacitive rings and prints one line per loop
at 9600 baud, roughly every 60 to 80 ms:

```
lag <tab> ring1 <tab> ring2 <tab> ring3 <tab> ring4 <tab> ring5
```

Values are raw capacitance counts, roughly 0 to 2000+. The sketch also drives its own NeoPixels;
nothing is sent back to it.

## Parameters and defaults

Defaults are the 2019 patch's startup values.

| Name | Range | Default | 2019 source |
| --- | --- | --- | --- |
| threshold | 0 to 2000 | 500 | `>= 500` everywhere |
| speed | 100 to 1000 ms | 213 | Speed slider (16), metro interval |
| loopLength | 50 to 3000 ms | 2373 | second slider (100), loop end offset |
| feedback | 0 to 0.99 | 0.678 | dial (87) scaled 0 to 0.99 |
| dryGain | dB | -6 | dry `gain~` (115); calibrate by ear |
| delayGain | dB | -10 | delay `gain~` (99); calibrate by ear |
| dataMin, dataMax | | 0.85, 1.2 | input range of the `zmap`s on the growth value |
| yearOffset | index | 0 | ring N reads data value `yearOffset + N - 1` |
| sound | 6 files | leaf2 | file message boxes; leaf2.wav at load |

## Behaviour

1. **Touch.** A ring is touched while its value is at or above `threshold`. Only changes of touched state matter.
2. **Touch starts.** Look up the ring's growth value `v` (ring N gives year N of the data; 1990 to 1994 with the 2019 values).
   - Playback rate = `v` mapped from dataMin..dataMax to 0.5..1.5, clipped.
   - Filter cutoff = `v` mapped from dataMin..dataMax to 50..10000 Hz, clipped (lowpass, Q about 0.7).
   - Start the wander clock.
3. **Touch ends.** Playback rate 0 (silence) and stop the wander clock. The clock's interval is left alone.
4. **One ring at a time (kept on purpose).** All rings write the same rate and clock, so the newest touch wins.
   Releasing any ring silences the sound even if another is still held. The piece reads more clearly this way.
   When several rings change in the same reading, handle the releases first and then the new touches, so sliding
   from one ring to the next keeps playing in either direction. (2019 handled the five values right to left, so
   sliding inward kept playing but sliding outward went silent.)
5. **Delay time.** Over all rings at or above threshold, take the strongest value and map threshold..2000 to 100..1000 ms
   (clipped). Ignore changes under 50 ms and glide slowly (about 0.5 s) to real ones: a delay time that keeps moving under
   feedback bends the pitch of the whole delay line, which sounds like bubbling. With nothing held, the last time stays.
6. **Wander.** Each clock tick (every `speed` ms, plus one tick as soon as the clock starts) moves a random walk over
   the file length, with a maximum step of 10% of the file length. Loop start = walk position; loop end = start +
   `loopLength` (capped at the file end). The playhead jumps to the new loop start on every tick, which gives the choppy,
   granular sound of the 2019 piece. Use a short crossfade (about 5 ms) on each jump to avoid clicks. At the default
   settings the playhead never reaches the loop end before the next jump, so `loopLength` only matters when `speed` is slow.
7. **Signal path.** The sample player loops continuously, playing channel 1 only, as `groove~` did.
   - Dry: player × dryGain to both outputs.
   - Delay: player into a delay line (5 s max) with feedback = tap × `feedback`, taken before the filter.
   - Wet: tap × delayGain into the lowpass filter, then to both outputs.

## Data

The 2019 patch used the growth index for 1990 to 2007 (18 values, Colorado Ponderosa Pine), which is in
`web/data/treedata.json`. A longer record (1600 to 2007, plus climate columns) exists. It will be added once its
source is attributed. With the full record, widen dataMin/dataMax to about 0.27 to 1.79 so low years don't clip.

## Changes from 2019

| 2019 behaviour | Now |
| --- | --- |
| Delay time jumped between held rings | Strongest held ring, with a dead band and a slow glide |
| Sliding outward between rings went silent | Releases handled before new touches, so both directions keep playing |
| Release set the clock interval to 0 | Release only stops the clock |
| Threshold hardcoded in several places | One `threshold` parameter |
| Sound chosen by hand in the patch | Chosen by the user; leaf2 by default |
