# TalkingTree.rnbopat: build spec

This spec covers rebuilding the sonification core of `TalkingTreePatch.maxpat` (2019) inside an
`rnbo~` patcher for the web export. The original `.maxpat` stays untouched. Objects marked
**(check)** are ones to confirm in your RNBO version's object list. Each has a fallback.

Decisions applied (2026-11-08):

| # | 2019 behaviour | In this port |
| --- | --- | --- |
| 1 | Last ring to change wins; any release silences | **Kept**: one ring "plays" at a time |
| 2 | Ring N plays year N (1990 to 1994) | **Kept**, but the values come from a loadable data buffer |
| 3 | Delay time jumps between held rings | **Fixed**: strongest held ring, smoothed |
| 4 | Release sets metro interval to 0 | **Fixed**: release only stops the metro |
| 5 | Threshold 500 hardcoded | **Fixed**: `threshold` param |
| 6 | Sound file chosen by hand, leaf2.wav default | Host lets the user pick; leaf2 stays the default |

## Host contract (names the web page will use)

Keep these names exactly. The page is being written against them.

### Params

| Name | Range | Default | Was in 2019 |
| --- | --- | --- | --- |
| `ring1` to `ring5` | 0 to 4000 | 0 | raw capacitive counts from the sketch |
| `threshold` | 0 to 2000 | 500 | `>= 500`, `if $i1 >= 500` |
| `yearOffset` | 0 to 1000 (int) | 390 | ring N reads `treedata[yearOffset + N - 1]`; 390 = 1990 in the 1600 to 2007 dataset |
| `dataMin` / `dataMax` | 0 to 3 | 0.85 / 1.2 | the `zmap 0.85 1.2 ...` input range (widen to 0.27 / 1.79 when the data expands) |
| `speed` | 100 to 1000 ms | 213 | Speed slider (16) > metro interval |
| `loopLength` | 50 to 3000 ms | 2373 | Second slider (100) > loop end offset |
| `feedback` | 0 to 0.99 | 0.678 | dial (87) > `scale 0 127 0 0.99` |
| `dryGain` | -70 to 6 dB | -6 | dry `gain~` (115); calibrate by ear |
| `delayGain` | -70 to 6 dB | -10 | delay `gain~` (99); calibrate by ear |

### Buffers (both loaded by the host)

| Name | Contents |
| --- | --- |
| `sample` | the sound file (mono or stereo), replaces `buffer~ skoBuffer` |
| `treedata` | 1 channel, one float per year: the `ring_index` column of `tree-ring-data.csv` (408 values, 1600 to 2007) |

### Outputs

`out~ 1` and `out~ 2` (same mono mix on both, as 2019 sent the same signal to both `ezdac~` inputs).

## Signal and event flow

```
ring1..5 ──► touch logic ──► rising: read treedata ─► v
                         │                          ├─► speed  = scale(v, dataMin, dataMax, 0.5, 1.5) clipped ─► sig~ ─► groove~ rate
                         │                          └─► cutoff = scale(v, dataMin, dataMax, 50, 10000) clipped ─► filtercoeff~ lowpass ─► biquad~ coeffs
                         │                          and start metro
                         └─ falling: groove~ rate 0, stop metro

strongest ring ≥ threshold ─► scale(threshold..2000 → 100..1000 ms) clipped ─► smooth (~80 ms) ─► delay time

metro (speed ms) ─► drunk over file length ─► loop start; loop start + loopLength ─► loop end ─► groove~

groove~ (loop 1) ─► × dryGain ─────────────────────────────────────┐
        └──► delay line (5000 ms max) ◄── × feedback ◄─┐           ├─► out~ 1, out~ 2
                    └── tap ─────────────────────────────┴► × delayGain ─► biquad~ ─┘
```

## Building it, block by block

### 1. Touch logic (one copy per ring, 5 copies)

- `param ring1 @min 0 @max 4000` → `>= ` with `param threshold` into its right inlet → `change`.
- `change` outputs only when the touched state flips. Route with `sel 1 0`:
  - **1 (rising)**: send the ring number (1 to 5) to the year lookup (block 2), then `1` to the metro.
  - **0 (falling)**: send `0` to the `sig~` feeding `groove~`'s rate, and `0` to the metro.
- Quirk 1 is kept because every ring writes to the same `sig~` and metro, so the last flip wins.
  That matches 2019, where all five toggles fed one toggle.
- If `change` in your RNBO version lacks the 2019 three-outlet form, the single-outlet `change` plus
  `sel 1 0` above does the same job.

### 2. Year lookup and mapping

- Ring number N → `+ ` with `param yearOffset` → `- 1` → index into `treedata`.
- Read with `peek~ treedata` or `buffer~ treedata` + `peek` **(check: whichever event-rate buffer read
  your version has)**. Output is the growth value v.
- `v` → `scale` with input range from `dataMin`/`dataMax`, output 0.5 to 1.5 → `clip 0.5 1.5` → `sig~` → `groove~` rate inlet.
- `v` → `scale` to 50 to 10000 → `clip 50 10000` → `filtercoeff~ lowpass` (cutoff) → `biquad~` coefficient inlets.
  Use Q around 0.7 to match `filtergraph~`'s default lowpass.
- `zmap` works too if your version has it **(check)**. `scale` + `clip` is the same thing.

### 3. Delay time (quirk 3 fix)

- Take all five ring params, replace any below `threshold` with 0, and keep the maximum
  (a chain of `maximum` objects, or one `codebox`).
- If the max is ≥ threshold: `scale threshold..2000 → 100..1000` → `clip 100 1000` → `line~` (or `slide~`) about 80 ms
  → `mstosamps~` → delay time. If nothing is held, hold the last value. 2019 did the same, since
  `if $i1 >= 500 then $i1` only passed held values.

### 4. Wandering loop (quirk 4 fix)

- `metro` with its interval from `param speed`. It is started and stopped only by the 1/0 from block 1;
  its interval is never set to 0.
- File length in ms: `info~ sample` → samples ÷ samplerate × 1000 **(check)**. Fallback: the host sends it,
  so add `param fileLengthMs` and I'll set it from the page after loading the file.
- Each metro tick → `drunk` with range = file length, step = file length × 0.1 (2019 wired `waveform~`'s length
  outlet to both, with `* 0.1` on the step) **(check `drunk`; fallback is a few lines of `codebox`)**.
- `drunk` output → `groove~` loop start; that value + `loopLength` → `groove~` loop end (in ms, as 2019 used them).
- `groove~ sample` with looping on (`loop 1` at load, or `@loop 1`).

### 5. Delay line with feedback

2019 did this: `groove~` → `tapin~ 5000`; `tapout~` → `*~ feedback` → back into `tapin~`, and `tapout~` → delay
`gain~` → `biquad~` → out. The feedback is taken before the filter.

- If your version has `tapin~`/`tapout~` **(check)**, rebuild it exactly that way.
- Otherwise use a `codebox~` along these lines (3 inputs: dry signal, delay in samples, feedback):

```
@state d = new Delay(samplerate() * 5);
let tap = d.read(in2, "linear");
d.write(in1 + tap * in3);
d.step();
out1 = tap;
```

  Exact `Delay` method names may differ slightly from gen; the RNBO codebox reference lists them.

### 6. Output

- Dry: `groove~` → `*~` (dbtoa of `dryGain`) → both outs.
- Wet: delay tap → `*~` (dbtoa of `delayGain`) → `biquad~` → both outs.
- Sum dry and wet into `out~ 1` and `out~ 2`.

## Not ported (handled by the web page instead)

`serial` and its parsing chain (`sel 13 10`, `zl group`, `itoa`, `fromsymbol`, `unpack`), `waveform~`,
`meter~`, `ezdac~`, `loadbang`, all UI objects, the file message boxes, and the unused `if ... then 1 else 0`,
`random 41000` and MIDI leftovers.

## Testing before export

1. Put the `rnbo~` in a host patch that keeps the 2019 `serial j 9600` chain and sends the five numbers to `param ring1`..`ring5`
   (`set ring1 $1` style messages into the `rnbo~` inlet).
2. Load `leaf2.wav` into `sample` and the CSV column into `treedata` (a `buffer~ treedata` filled from a `coll` or text file in the host is fine).
3. Touch each ring and compare with the 2019 patch running side by side, then adjust `dryGain`/`delayGain` until they match.
4. Export with **Web Export**, and put the output folder in `web/export/` of this repo.
