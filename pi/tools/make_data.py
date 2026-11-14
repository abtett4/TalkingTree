#!/usr/bin/env python3
"""Builds data/years.txt and data/range.txt for the Pd patch from web/data/treedata.json.

Run it again whenever the tree-ring data changes:  python3 pi/tools/make_data.py

years.txt has one line per year:  year growth memory sound;
  memory = average growth of the previous 5 years (the first year uses its own value),
           scaled 0..1 across all years' averages. The patch turns it into delay feedback.
  sound  = leaf2 for years at or above the average growth, log3 below.
range.txt holds the data's min and max growth, used to centre the mapping.
"""
import json
from pathlib import Path

MEMORY_YEARS = 5
here = Path(__file__).resolve().parent.parent
data = json.loads((here.parent / "web" / "data" / "treedata.json").read_text())
values, start = data["values"], data["startYear"]

memory = []
for i, v in enumerate(values):
    prev = values[max(0, i - MEMORY_YEARS):i]
    memory.append(sum(prev) / len(prev) if prev else v)
lo, hi = min(memory), max(memory)
mean = sum(values) / len(values)

out = here / "data"
out.mkdir(exist_ok=True)
with open(out / "years.txt", "w", newline="\n") as f:
    for i, v in enumerate(values):
        m = (memory[i] - lo) / (hi - lo) if hi > lo else 0.5
        f.write(f"{start + i} {v} {m:.4f} {'leaf2' if v >= mean else 'log3'};\n")
(out / "range.txt").write_text(f"{min(values)} {max(values)};\n", newline="\n")
print(f"wrote {len(values)} years ({start} to {start + len(values) - 1}) to {out}")
