// Talking Tree, web version: the 2019 Max/MSP patch rebuilt in plain Web Audio.

let RINGS = 0; // one ring per year in data/treedata.json, set at load
const SENSOR_RINGS = 5; // rings on the physical tree; they play the first five years
const FRAME_MS = 66; // the Arduino sketch prints roughly every 60-80 ms
const POINTER_STRENGTH = 1400;
const CUTOFF_CENTER_HZ = 1100; // delay filter cutoff for a year in the middle of the data's range
const XFADE_S = 0.005; // crossfade when the playhead jumps into a new loop window
const QUIET_DB = -60; // waveform view: output below this counts as dead air
const MEMORY_YEARS = 5; // the delay's feedback follows the average of this many previous years
const SOUND_ABOVE = "leaf2"; // played for years at or above the data's average growth
const SOUND_BELOW = "log3"; // played for years below it
const DEBUG = new URLSearchParams(location.search).has("debug"); // ?debug shows settings and the playback view
const DELAY_DEADBAND_MS = 50; // ignore delay-time changes smaller than this (touch-strength wobble)

// Defaults are the 2019 patch's loadbang values (see docs/BEHAVIOR.md).
// Slider ranges were retuned in 2026 so they work together: the two timing sliders share one
// range and a log scale (equal travel = equal ratio), and both level sliders share one dB range.
const PARAMS = [
  { id: "speed", label: "Jump every", min: 40, max: 1000, log: true, value: 213, unit: "ms" },
  { id: "loopLength", label: "Loop length", min: 40, max: 1000, log: true, value: 1000, unit: "ms" },
  { id: "speedSpread", label: "Speed spread", min: 0, max: 4, step: 0.1, value: 2.5, unit: "oct" },
  { id: "brightSpread", label: "Brightness spread", min: 0, max: 8, step: 0.1, value: 6.9, unit: "oct" },
  { id: "jump", label: "Jump distance", min: 0, max: 100, step: 1, value: 35, unit: "%" },
  { id: "dryGain", label: "Dry level", min: -48, max: 12, step: 0.5, value: -6, unit: "dB" },
  { id: "delayGain", label: "Delay level", min: -48, max: 12, step: 0.5, value: -22, unit: "dB" },
  { id: "echoMin", label: "Echo after lean years", min: 0, max: 0.95, step: 0.01, value: 0.15, unit: "" },
  { id: "echoMax", label: "Echo after good years", min: 0, max: 0.95, step: 0.01, value: 0.6, unit: "" },
  { id: "threshold", label: "Touch threshold", min: 0, max: 2000, step: 1, value: 500, unit: "" },
];
// Not shown as sliders. Ring N plays data year yearOffset + N - 1; dataMin/dataMax is the 2019 mapping range.
const HIDDEN = { yearOffset: 0, dataMin: 0.85, dataMax: 1.2 };

const $ = (id) => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const scaleClip = (x, a, b, c, d) => clamp(c + ((x - a) / (b - a)) * (d - c), Math.min(c, d), Math.max(c, d));
const dbToGain = (db) => Math.pow(10, db / 20);

let ctx = null;
let engine = null;
let treeData = null; // { startYear, values }
let sources = null; // per input: one strength value per ring
let rings = [];

// Average of the `years` values before each one (fewer at the start; the first year uses itself).
function trailingAverages(values, years) {
  return values.map((v, i) => {
    const prev = values.slice(Math.max(0, i - years), i);
    return prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : v;
  });
}

// ---------------------------------------------------------------- engines

// The sound engine: the 2019 Max patch rebuilt in Web Audio. Behaviour follows docs/BEHAVIOR.md.
class Engine {
  constructor(ctx) {
    this.ctx = ctx;
    this.p = Object.fromEntries(PARAMS.map((p) => [p.id, p.value]));
    Object.assign(this.p, HIDDEN);
    this.data = [];
    this.touched = new Array(RINGS).fill(false);
    this.buffer = null;
    this.source = null;
    this.rate = 0;
    this.walk = 0;
    this.timer = null;
    this.pos = 0;
    this.ring = -1;
    this.cutoff = 10000;
    this.feedback = 0.68;
    this.memory = []; // per year: average growth of the previous MEMORY_YEARS years
    this.mean = 1;
    this.samples = {}; // { above: {buffer, name}, below: {buffer, name} }
    this.manual = null; // a fixed {buffer, name} chosen in the debug panel, or null for "by year"
    this.bufferName = "";
    this.onBuffer = () => {};
    this.delayMs = 100;

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.delay = ctx.createDelay(5);
    this.fb = ctx.createGain();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.Q.value = 0.707;
    this.filter.frequency.value = 10000;
    this.delay.delayTime.value = 0.1;
    this.delay.connect(this.fb).connect(this.delay); // feedback taken before the filter, as in 2019
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.out.connect(this.analyser);
    this.out.connect(ctx.destination);
    this.delay.connect(this.wet).connect(this.filter).connect(this.out);
    this.dry.connect(this.out);
    this.applyLevels();
  }
  applyLevels() {
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(dbToGain(this.p.dryGain), t, 0.02);
    this.wet.gain.setTargetAtTime(dbToGain(this.p.delayGain), t, 0.02);
    this.fb.gain.setTargetAtTime(this.feedback, t, 0.02);
  }
  setParam(id, value) {
    this.p[id] = value;
    this.applyLevels();
    if (id === "speed" && this.timer) this.startMetro();
  }
  setSample({ buffer, name }) {
    if (this.buffer === buffer) return;
    this.buffer = buffer;
    this.bufferName = name;
    this.walk %= buffer.duration * 1000;
    this.onBuffer(buffer, name);
    this.step();
  }
  setTreeData(values) {
    this.data = values;
    this.mean = values.reduce((a, b) => a + b, 0) / values.length;
    this.memory = trailingAverages(values, MEMORY_YEARS);
  }
  setRings(values) {
    const thr = this.p.threshold;
    const changes = values.map((v, i) => ((v >= thr) === this.touched[i] ? null : v >= thr));
    // Releases first, then new touches, so sliding from one ring to the next keeps playing in
    // either direction. (2019 handled the five values right to left, so sliding outward went silent.)
    changes.forEach((on, i) => {
      if (on !== false) return;
      this.touched[i] = false;
      this.setRate(0);
      this.stopMetro(); // quirk 4 fixed: the interval is left alone
    });
    // Quirk 1 kept: every ring writes the same rate and metro, so the newest touch wins.
    changes.forEach((on, i) => {
      if (on !== true) return;
      this.touched[i] = true;
      this.ring = i;
      const g = this.data[this.p.yearOffset + i];
      if (g !== undefined) {
        // Map in octaves, not linearly, so equal steps in growth sound like equal steps in pitch and
        // brightness. n = 0 for the slowest-growing year, 1 for the fastest, 0.5 in the middle.
        const n = scaleClip(g, this.p.dataMin, this.p.dataMax, 0, 1) - 0.5;
        this.setRate(Math.pow(2, this.p.speedSpread * n)); // 1x at the middle of the data's range
        this.cutoff = clamp(CUTOFF_CENTER_HZ * Math.pow(2, this.p.brightSpread * n), 40, 16000);
        this.filter.frequency.setTargetAtTime(this.cutoff, this.ctx.currentTime, 0.01);
        // The delay is the tree's memory: after a run of good years the echoes last longer.
        const m = this.memory[this.p.yearOffset + i];
        const mLo = Math.min(...this.memory), mHi = Math.max(...this.memory);
        this.feedback = this.p.echoMin + scaleClip(m, mLo, mHi, 0, 1) * (this.p.echoMax - this.p.echoMin);
        this.applyLevels();
        // Above-average years play the leaves, below-average years the log.
        const pick = this.manual ?? (g >= this.mean ? this.samples.above : this.samples.below);
        if (pick) this.setSample(pick);
      }
      this.startMetro();
    });
    // Quirk 3 fixed: strongest held ring sets the delay time. Small wobbles in touch strength are
    // ignored and real changes glide slowly: a delay time that keeps moving under feedback bends
    // the pitch of everything in the delay line, which sounds like bubbling.
    const held = values.filter((v) => v >= thr);
    if (held.length) {
      const ms = scaleClip(Math.max(...held), thr, 2000, 100, 1000);
      if (Math.abs(ms - this.delayMs) >= DELAY_DEADBAND_MS) {
        this.delayMs = ms;
        this.delay.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.15);
      }
    }
  }
  // Where the playhead is (seconds), estimated from the rate and loop points, for the waveform view.
  playhead() {
    const now = this.ctx.currentTime;
    const dt = now - (this.lastT ?? now);
    this.lastT = now;
    if (!this.buffer || !this.source) return 0;
    let pos = this.pos + this.rate * dt;
    const { loopStart: a, loopEnd: b } = this.source;
    if (pos >= b && b > a) pos = a + ((pos - b) % (b - a));
    if (pos >= this.buffer.duration) pos = 0;
    this.pos = pos;
    return pos;
  }
  setRate(r) {
    this.rate = r;
    if (this.source) this.source.playbackRate.setValueAtTime(r, this.ctx.currentTime);
  }
  startMetro() {
    this.stopMetro();
    this.step(); // a Max metro bangs as soon as it starts
    this.timer = setInterval(() => this.step(), this.p.speed);
  }
  stopMetro() {
    clearInterval(this.timer);
    this.timer = null;
  }
  // drunk over the file length (2019 used a step of 10% of the file; now the Jump distance slider). Each tick the
  // playhead jumps into the new loop window, as groove~ did in 2019: that is the choppy,
  // granular sound. A browser buffer source can't seek, so each tick starts a new one and
  // crossfades over a few ms to avoid clicks.
  step() {
    if (!this.buffer) return;
    const len = this.buffer.duration * 1000;
    // Max jump per tick as a share of the file. Wraps around the ends instead of sticking to them.
    const maxStep = len * (this.p.jump / 100);
    this.walk = (((this.walk + (Math.random() * 2 - 1) * maxStep) % len) + len) % len;
    const start = this.walk / 1000;
    const end = Math.max(Math.min(len, this.walk + this.p.loopLength) / 1000, start + 0.01);

    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.loop = true;
    s.loopStart = start;
    s.loopEnd = end;
    s.playbackRate.value = this.rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + XFADE_S);
    s.connect(g);
    g.connect(this.dry);
    g.connect(this.delay);
    s.start(t, start);
    if (this.source) {
      const old = this.source, oldGain = this.voiceGain;
      oldGain.gain.setValueAtTime(1, t);
      oldGain.gain.linearRampToValueAtTime(0, t + XFADE_S);
      old.stop(t + XFADE_S + 0.01);
      old.onended = () => oldGain.disconnect();
    }
    this.source = s;
    this.voiceGain = g;
    this.pos = start;
    this.lastT = t;
  }
}

// ---------------------------------------------------------------- data and audio

async function loadTreeData() {
  const res = await fetch("data/treedata.json");
  treeData = await res.json();
  RINGS = treeData.values.length;
  const zeros = () => new Array(RINGS).fill(0);
  sources = { pointer: zeros(), serial: zeros(), demo: zeros() };
  rings = zeros();
}

const sampleCache = new Map();
async function loadBuffer(name) {
  if (!sampleCache.has(name)) {
    const res = await fetch(`audio/${name}.mp3`);
    if (!res.ok) throw new Error(`Could not load ${name}.mp3`);
    sampleCache.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
  }
  return { buffer: sampleCache.get(name), name };
}

// "auto" = the data picks the sound per year; any other value fixes one file (debug panel only).
async function chooseSound(value) {
  if (value === "auto") {
    engine.manual = null;
  } else {
    engine.manual = await loadBuffer(value);
    engine.setSample(engine.manual);
  }
}

// ---------------------------------------------------------------- tree drawing and touch

const svg = $("tree");
const NS = "http://www.w3.org/2000/svg";
const R_PITH = 20; // leaves room for the Start button in the middle
const R_OUTER = 104;
const lights = [];
let edges = []; // edges[i]..edges[i+1] = radius range of ring i

// Ring widths follow the growth index, like a real cross-section, but compressed
// (half fixed, half proportional) so the thinnest years stay big enough to touch.
function computeEdges() {
  const v = treeData.values;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const w = v.map((x) => 0.5 + (0.5 * x) / mean);
  const k = (R_OUTER - R_PITH) / w.reduce((a, b) => a + b, 0);
  edges = [R_PITH];
  w.forEach((x) => edges.push(edges.at(-1) + x * k));
}

function ringPath(r1, r2) {
  const circle = (r, sweep) => `M ${-r} 0 A ${r} ${r} 0 1 ${sweep} ${r} 0 A ${r} ${r} 0 1 ${sweep} ${-r} 0 Z`;
  return `${circle(r2, 0)} ${circle(r1, 1)}`;
}

function drawTree() {
  // Innermost ring is the earliest year, as in a real cross-section.
  computeEdges();
  for (let i = 0; i < RINGS; i++) {
    const band = document.createElementNS(NS, "path");
    band.setAttribute("d", ringPath(edges[i], edges[i + 1]));
    band.setAttribute("fill-rule", "evenodd");
    band.setAttribute("class", `band ${i % 2 ? "odd" : "even"}`);
    const light = band.cloneNode();
    light.setAttribute("class", "light");
    light.style.opacity = 0;
    svg.append(band, light);
    lights[i] = light;
  }
  const pith = document.createElementNS(NS, "circle");
  pith.setAttribute("r", R_PITH);
  pith.setAttribute("class", "band odd");
  svg.append(pith);
  // Label every fifth year; the readout names whichever ring is playing.
  for (let i = 0; i < RINGS; i++) {
    if ((treeData.startYear + i) % 5 !== 0) continue;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "label");
    t.setAttribute("y", -(edges[i] + edges[i + 1]) / 2 + 1.6);
    t.textContent = treeData.startYear + i;
    svg.append(t);
  }
}

// Ring 1 = the first year in the loaded data file (1990 for the 2019 values).
const yearFor = (i) => (treeData ? treeData.startYear + i : null);
const growthFor = (i) => (treeData ? treeData.values[i] : null);


function ringAt(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const d = Math.hypot(p.x, p.y);
  if (d < R_PITH || d > R_OUTER) return -1;
  for (let i = 0; i < RINGS; i++) if (d < edges[i + 1]) return i;
  return RINGS - 1;
}

// Mouse and touch press with a steady, medium-firm strength (delay time about 640 ms).
let pointerRing = -1;
svg.addEventListener("pointerdown", (e) => {
  if (!engine) return;
  pointerRing = ringAt(e);
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener("pointermove", (e) => {
  if (pointerRing < 0) return;
  const r = ringAt(e);
  if (r >= 0 && r !== pointerRing) {
    pointerRing = r;
  }
});
const release = () => (pointerRing = -1);
svg.addEventListener("pointerup", release);
svg.addEventListener("pointercancel", release);

function updatePointer() {
  sources.pointer.fill(0);
  if (pointerRing >= 0) {
    sources.pointer[pointerRing] = POINTER_STRENGTH;
  }
}

// ---------------------------------------------------------------- demo mode

let demoTimer = null;
function startDemo() {
  const next = () => {
    sources.demo.fill(0);
    const ring = Math.floor(Math.random() * RINGS);
    const hold = 1200 + Math.random() * 2500;
    sources.demo[ring] = Math.round(700 + Math.random() * 1300);
    demoTimer = setTimeout(() => {
      sources.demo.fill(0);
      demoTimer = setTimeout(next, 400 + Math.random() * 1600);
    }, hold);
  };
  next();
}
function stopDemo() {
  clearTimeout(demoTimer);
  demoTimer = null;
  sources.demo.fill(0);
}

// ---------------------------------------------------------------- Arduino over Web Serial

async function connectSerial() {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 9600 });
  status("Arduino connected.");
  $("serial").textContent = "Arduino connected";
  $("serial").disabled = true;
  const reader = port.readable.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        // Sketch prints: lag \t ring1 \t ring2 \t ring3 \t ring4 \t ring5
        const parts = line.trim().split(/\s+/).map(Number);
        if (parts.length >= 6 && parts.every(Number.isFinite)) {
          for (let i = 0; i < SENSOR_RINGS; i++) sources.serial[i] = parts[i + 1];
        }
      }
    }
  } finally {
    sources.serial.fill(0);
    status("Arduino disconnected.");
    $("serial").textContent = "Connect Arduino";
    $("serial").disabled = false;
  }
}



// ---------------------------------------------------------------- growth chart

// One bar per year, drawn up or down from the average (above = leaves, below = log), with the
// previous-5-year average (the delay's memory) as a line. The playing year is highlighted.
const chart = {
  svg: $("chart"),
  bars: [],
  build() {
    const v = treeData.values;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const memory = trailingAverages(v, MEMORY_YEARS);
    const W = 400, H = 220, L = 30, R = 6, T = 8, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const y0 = 0, y1 = 1.5; // start at zero growth so bar lengths read honestly
    const y = (x) => T + ph * (1 - (x - y0) / (y1 - y0));
    const band = pw / v.length;
    const svg = this.svg;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const el = (tag, attrs, text) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val);
      if (text !== undefined) e.textContent = text;
      svg.append(e);
      return e;
    };
    for (const g of [0, 0.5, 1.5]) {
      el("line", { class: "grid", x1: L, x2: W - R, y1: y(g), y2: y(g) });
      el("text", { class: "axis", x: L - 6, y: y(g) + 3.5, "text-anchor": "end" }, g === 0 ? "0" : g.toFixed(1));
    }
    v.forEach((val, i) => {
      const x = L + i * band + 1, w = band - 2; // 2px gap between bars
      const top = y(Math.max(val, mean)), bot = y(Math.min(val, mean));
      const r = Math.min(2, w / 2, (bot - top) / 2);
      // Round only the data end; the end on the average line stays square.
      const d = val >= mean
        ? `M ${x} ${bot} V ${top + r} Q ${x} ${top} ${x + r} ${top} H ${x + w - r} Q ${x + w} ${top} ${x + w} ${top + r} V ${bot} Z`
        : `M ${x} ${top} V ${bot - r} Q ${x} ${bot} ${x + r} ${bot} H ${x + w - r} Q ${x + w} ${bot} ${x + w} ${bot - r} V ${top} Z`;
      this.bars[i] = el("path", { class: `bar ${val >= mean ? "above" : "below"}`, d });
      const year = treeData.startYear + i;
      if (year % 5 === 0) el("text", { class: "axis", x: x + w / 2, y: H - 6, "text-anchor": "middle" }, year);
    });
    el("line", { class: "meanline", x1: L, x2: W - R, y1: y(mean), y2: y(mean) });
    el("text", { class: "axis", x: L - 6, y: y(mean) + 3.5, "text-anchor": "end" }, "avg");
    el("polyline", { class: "memory", points: memory.map((m, i) => `${L + (i + 0.5) * band},${y(m)}`).join(" ") });

    // Hover: hit targets are the full column, wider than the bar.
    const tip = $("tip");
    v.forEach((val, i) => {
      const hit = el("rect", { class: "hit", x: L + i * band, y: T, width: band, height: ph });
      const show = () => {
        const year = treeData.startYear + i;
        const diff = ((val / mean - 1) * 100).toFixed(0);
        tip.innerHTML = `<strong>${year}</strong><br>growth ${val.toFixed(2)} (${diff >= 0 ? "+" : ""}${diff}% vs average)<br>previous 5 years ${memory[i].toFixed(2)}<br>sound: ${val >= mean ? "leaves" : "log"}`;
        const box = svg.getBoundingClientRect();
        tip.style.left = `${((L + (i + 0.5) * band) / W) * box.width}px`;
        tip.style.top = `${(y(Math.max(val, mean)) / H) * box.height}px`;
        tip.hidden = false;
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("pointerleave", () => (tip.hidden = true));
    });

    const tbody = $("datatable").querySelector("tbody");
    v.forEach((val, i) => {
      const tr = document.createElement("tr");
      for (const cell of [treeData.startYear + i, val.toFixed(3), memory[i].toFixed(3), val >= mean ? "leaves" : "log"]) {
        const td = document.createElement("td");
        td.textContent = cell;
        tr.append(td);
      }
      tbody.append(tr);
    });
  },
  highlight(i) {
    this.svg.classList.toggle("playing", i >= 0);
    this.bars.forEach((b, j) => b.classList.toggle("on", j === i));
  },
};

// ---------------------------------------------------------------- waveform view (debugging)

// Shows the current sound file, the wandering loop window, the playhead, and the output level,
// so quiet stretches ("dead air") can be matched to the part of the file being played.
const waveform = {
  canvas: $("wave"),
  peaks: null,
  buffer: null,
  name: "",
  levelDb: -Infinity,
  setBuffer(buffer, name) {
    this.buffer = buffer;
    this.name = name;
    this.peaks = null;
  },
  computePeaks(width) {
    const data = this.buffer.getChannelData(0); // channel 1 only, as played
    const per = Math.max(1, Math.floor(data.length / width));
    const peaks = new Float32Array(width * 2);
    for (let x = 0; x < width; x++) {
      let lo = 1, hi = -1;
      const end = Math.min(data.length, (x + 1) * per);
      for (let j = x * per; j < end; j++) {
        const v = data[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      peaks[2 * x] = lo;
      peaks[2 * x + 1] = hi;
    }
    this.peaks = peaks;
    this.peakWidth = width;
  },
  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.peaks = null;
    }
    const g = c.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const col = (name) => css.getPropertyValue(name).trim();
    g.clearRect(0, 0, w, h);
    if (!this.buffer || !engine?.source) return;
    if (!this.peaks || this.peakWidth !== w) this.computePeaks(w);
    const dur = this.buffer.duration;
    const toX = (t) => (t / dur) * w;
    const src = engine.source;

    // Loop window
    g.fillStyle = col("--loop");
    const x0 = toX(src.loopStart);
    g.fillRect(x0, 0, Math.max(1, toX(src.loopEnd) - x0), h);

    // Waveform
    g.fillStyle = col("--wave");
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const lo = this.peaks[2 * x], hi = this.peaks[2 * x + 1];
      g.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
    }

    // Playhead
    const t = engine.playhead();
    g.fillStyle = engine.rate > 0 ? col("--glow") : col("--muted");
    g.fillRect(toX(t) - dpr, 0, 2 * dpr, h);

    // Output level from the analyser (RMS, dBFS)
    const a = engine.analyser;
    const buf = this.levelBuf || (this.levelBuf = new Float32Array(a.fftSize));
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 10 * Math.log10(sum / buf.length + 1e-12);
    this.levelDb = Math.max(db, this.levelDb - 1.5); // fall back slowly so it can be read
    const meter = $("meter");
    meter.style.width = `${clamp((this.levelDb + 80) / 80, 0, 1) * 100}%`;
    meter.classList.toggle("quiet", this.levelDb < QUIET_DB);

    const fmt = (x) => x.toFixed(2);
    const year = engine.ring >= 0 && engine.rate > 0 ? yearFor(engine.ring) : "none";
    $("waveinfo").textContent =
      `${this.name}.mp3 (${fmt(dur)} s)  ·  playhead ${fmt(t)} s  ·  loop ${fmt(src.loopStart)} to ${fmt(src.loopEnd)} s\n` +
      `ring: ${year}  ·  rate ${fmt(engine.rate)}x  ·  cutoff ${Math.round(engine.cutoff)} Hz  ·  delay ${Math.round(engine.delayMs)} ms  ·  echo ${fmt(engine.feedback)}  ·  output ${isFinite(this.levelDb) ? Math.round(this.levelDb) : "-inf"} dB`;
  },
};

function animate() {
  if (!DEBUG) return; // the playback view only exists in debug mode
  waveform.draw();
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------- main loop and UI

function frame() {
  updatePointer();
  rings = rings.map((_, i) => Math.max(sources.pointer[i], sources.serial[i], sources.demo[i]));
  engine.setRings(rings);
  const thr = paramValue("threshold");
  let active = -1;
  rings.forEach((v, i) => {
    // Same brightness curve as the sketch's NeoPixels: map(0..2000 -> 0..150 of 255).
    lights[i].style.opacity = v >= thr ? clamp((v / 2000) * (150 / 255) * 1.6, 0.25, 1) : 0;
    if (v >= thr) active = i;
  });
  const playing = engine.rate > 0 ? engine.ring : -1;
  chart.highlight(playing);
  if (playing >= 0) {
    const sound = engine.bufferName.startsWith("leaf") ? "leaves" : "log";
    $("readout").textContent = `${yearFor(playing)}: growth index ${growthFor(playing).toFixed(2)} · ${sound}`;
  }
}

const paramInputs = {};
function paramValue(id) {
  return paramInputs[id] ? paramInputs[id].read() : HIDDEN[id];
}
function buildParams() {
  for (const p of PARAMS) {
    const label = document.createElement("label");
    label.textContent = p.label;
    // Log sliders run 0..1000 internally and map to min..max exponentially.
    const toValue = (pos) => (p.log ? Math.round(p.min * Math.pow(p.max / p.min, pos / 1000)) : pos);
    const toPos = (v) => (p.log ? (1000 * Math.log(v / p.min)) / Math.log(p.max / p.min) : v);
    const input = p.log
      ? Object.assign(document.createElement("input"), { type: "range", min: 0, max: 1000, step: 1 })
      : Object.assign(document.createElement("input"), { type: "range", min: p.min, max: p.max, step: p.step });
    input.read = () => toValue(+input.value);
    input.reset = () => {
      input.value = toPos(p.value);
      show();
      engine?.setParam(p.id, input.read());
    };
    const out = document.createElement("output");
    const show = () => {
      const v = input.read();
      out.textContent = `${+v.toFixed(p.step < 1 ? 2 : 0)}${p.unit ? " " + p.unit : ""}`;
    };
    input.addEventListener("input", () => {
      show();
      engine?.setParam(p.id, input.read());
    });
    input.value = toPos(p.value);
    show();
    label.append(input, out);
    $("params").append(label);
    paramInputs[p.id] = input;
  }
  const reset = Object.assign(document.createElement("button"), { type: "button", textContent: "Reset to defaults", className: "reset" });
  reset.addEventListener("click", () => Object.values(paramInputs).forEach((i) => i.reset()));
  $("params").append(reset);
}

function status(msg) {
  $("status").textContent = msg;
}

// The button in the middle of the tree starts the piece, then pauses and resumes it.
$("start").addEventListener("click", async () => {
  if (engine) {
    if (ctx.state === "running") {
      await ctx.suspend();
      $("start").textContent = "Resume";
      $("start").classList.remove("on");
    } else {
      await ctx.resume();
      $("start").textContent = "Pause";
      $("start").classList.add("on");
    }
    return;
  }
  $("start").disabled = true;
  status("Loading…");
  try {
    ctx = new AudioContext();
    engine = new Engine(ctx);
    for (const p of PARAMS) engine.setParam(p.id, paramValue(p.id));
    // Map the data's own range onto rate and cutoff, so no year clips. (2019 used 0.85 to 1.2,
    // which only fit its five years.)
    engine.setParam("dataMin", Math.min(...treeData.values));
    engine.setParam("dataMax", Math.max(...treeData.values));
    await engine.setTreeData(treeData.values);
    engine.onBuffer = (buffer, name) => waveform.setBuffer(buffer, name);
    engine.samples = { above: await loadBuffer(SOUND_ABOVE), below: await loadBuffer(SOUND_BELOW) };
    engine.setSample(engine.samples.above);
    await chooseSound($("sound").value);
    setInterval(frame, FRAME_MS);
    requestAnimationFrame(animate);
    $("start").textContent = "Pause";
    $("start").classList.add("on"); // amber while the sound is on
    $("start").disabled = false;
    $("demo").disabled = false;
    $("sound").disabled = false;
    if ("serial" in navigator) {
      $("serial").hidden = false;
      $("serial").disabled = false;
    }
    $("readout").textContent = "Touch and hold a ring.";
    status("");
  } catch (err) {
    console.error(err);
    status(`Could not start: ${err.message}`);
    engine = null;
    $("start").disabled = false;
  }
});

$("demo").addEventListener("click", () => {
  const on = $("demo").getAttribute("aria-pressed") !== "true";
  $("demo").setAttribute("aria-pressed", on);
  on ? startDemo() : stopDemo();
});

$("serial").addEventListener("click", () => connectSerial().catch((err) => status(`Serial: ${err.message}`)));

$("sound").addEventListener("change", () => chooseSound($("sound").value).catch((err) => status(err.message)));

buildParams();
if (DEBUG) document.body.classList.add("debug");
document.querySelector(".datatable").addEventListener("toggle", (e) => document.body.classList.toggle("table-open", e.target.open));
loadTreeData()
  .then(() => {
    drawTree();
    chart.build();
  })
  .catch((err) => status(`Could not load tree data: ${err.message}`));
