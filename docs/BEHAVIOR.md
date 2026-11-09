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
| speed ("Jump every") | 40 to 1000 ms, log | 213 | Speed slider (16), metro interval; 2019 range 100 to 1000 |
| speedSpread | 0 to 4 octaves | 2.5 | was a linear 0.5 to 1.5x |
| brightSpread | 0 to 8 octaves | 6.9 | was a linear 50 to 10000 Hz |
| jump | 0 to 100 % of the file | 35 | `drunk` step, 10% in 2019; raised so playback roams more |
| loopLength | 40 to 1000 ms, log | 1000 | second slider, loop end offset. 2019 ran 50 to 3000 (default 2373), always longer than the jump interval, so it never audibly repeated. Now it shares the speed range: below "Jump every" it repeats, at or above it does not |
| echoMin, echoMax | 0 to 0.95 | 0.3, 0.9 | feedback range; the year picks a value in it (see Memory below). 2019 had one feedback dial (0.68) |
| dryGain | -48 to +12 dB | -6 | dry `gain~` (115) |
| delayGain | -48 to +12 dB | -22 | delay `gain~` (99); set by ear in 2026 |
| dataMin, dataMax | | min and max of the loaded data (0.37, 1.44 for 1990 to 2007) | 2019 used 0.85, 1.2, which only fit its five years |
| yearOffset | index | 0 | ring N reads data value `yearOffset + N - 1` |
| sound | by year | leaf2 for years at or above average, log3 below | file message boxes; leaf2.wav at load |

## Behaviour

1. **Touch.** A ring is touched while its value is at or above `threshold`. Only changes of touched state matter.
2. **Touch starts.** Look up the ring's growth value `v`. There is one ring per year of data (18 rings, 1990 to 2007).
   The physical tree's five sensors play the first five years (1990 to 1994), as in 2019.
   - Let `n` = `v` mapped from dataMin..dataMax to -0.5..+0.5, clipped (0 = the middle of the data's range).
   - Playback rate = 2^(speedSpread × n): 1x in the middle, and the slowest to fastest years span `speedSpread` octaves.
   - Filter cutoff = 1100 Hz × 2^(brightSpread × n) (lowpass, Q about 0.7): with the defaults, about 100 Hz to 12 kHz.
   - **Memory:** feedback = echoMin + (echoMax - echoMin) × the previous-5-year average growth, scaled across the
     data's range of those averages. After a run of good years the echoes last longer. (The first year has no previous
     years and uses its own value.) These averages come only from the data, never from how the person touches.
   - **Sound:** years at or above the data's average growth play leaf2; years below it play log3.
   - 2019 mapped linearly to 0.5..1.5x and 50..10000 Hz. Octave mapping makes each step in growth sound like an equal step.
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
   the file length, with a maximum step of `jump` percent of the file length, wrapping around at the ends. Loop start = walk position; loop end = start +
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
| Random walk moved at most 10% of the file and stuck at the ends | `jump` setting (default 35%), wraps around the ends |
| 5 rings, years 1990 to 1994 | 18 on-screen rings, 1990 to 2007, widths following growth; mapping range set from the data |
| Linear 0.5 to 1.5x rate, 50 to 10000 Hz cutoff | Octave mapping with spread settings (defaults about 0.42 to 2.4x and 100 Hz to 12 kHz) |
| Sound chosen by hand in the patch | The year picks it: leaf2 above average, log3 below |
| One fixed feedback amount | Feedback follows the previous-5-year average |
