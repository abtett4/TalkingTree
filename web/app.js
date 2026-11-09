// Talking Tree, web version: the 2019 Max/MSP patch rebuilt in plain Web Audio.

const RINGS = 5;
const FRAME_MS = 66; // the Arduino sketch prints roughly every 60-80 ms
const POINTER_STRENGTH = 1400;
const QUIET_DB = -60; // waveform view: output below this counts as dead air
const DELAY_DEADBAND_MS = 50; // ignore delay-time changes smaller than this (touch-strength wobble)

// Defaults are the 2019 patch's loadbang values (see docs/BEHAVIOR.md).
const PARAMS = [
  { id: "speed", label: "Wander speed", min: 100, max: 1000, step: 1, value: 213, unit: "ms" },
  { id: "loopLength", label: "Loop length", min: 50, max: 3000, step: 1, value: 2373, unit: "ms" },
  { id: "feedback", label: "Feedback", min: 0, max: 0.99, step: 0.01, value: 0.678, unit: "" },
  { id: "dryGain", label: "Dry level", min: -70, max: 6, step: 0.5, value: -6, unit: "dB" },
  { id: "delayGain", label: "Delay level", min: -70, max: 6, step: 0.5, value: -10, unit: "dB" },
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
const sources = { pointer: new Array(RINGS).fill(0), serial: new Array(RINGS).fill(0), demo: new Array(RINGS).fill(0) };
let rings = new Array(RINGS).fill(0);

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
    this.fb.gain.setTargetAtTime(this.p.feedback, t, 0.02);
  }
  setParam(id, value) {
    this.p[id] = value;
    this.applyLevels();
    if (id === "speed" && this.timer) this.startMetro();
  }
  async setSample(audioBuffer) {
    this.buffer = audioBuffer;
    if (this.source) this.source.stop();
    const s = this.ctx.createBufferSource();
    s.buffer = audioBuffer;
    s.loop = true;
    s.playbackRate.value = this.rate;
    s.connect(this.dry);
    s.connect(this.delay);
    s.start();
    this.source = s;
    this.walk = 0;
    this.pos = 0;
    this.step();
  }
  async setTreeData(values) {
    this.data = values;
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
        this.setRate(scaleClip(g, this.p.dataMin, this.p.dataMax, 0.5, 1.5));
        this.cutoff = scaleClip(g, this.p.dataMin, this.p.dataMax, 50, 10000);
        this.filter.frequency.setTargetAtTime(this.cutoff, this.ctx.currentTime, 0.01);
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
    this.timer = setInterval(() => this.step(), this.p.speed);
  }
  stopMetro() {
    clearInterval(this.timer);
    this.timer = null;
  }
  // drunk over the file length, step = 10% of it, as 2019 wired from waveform~.
  step() {
    if (!this.source || !this.buffer) return;
    const len = this.buffer.duration * 1000;
    const maxStep = len * 0.1;
    this.walk = clamp(this.walk + (Math.random() * 2 - 1) * maxStep, 0, len - 1);
    const start = this.walk / 1000;
    const end = Math.min(len, this.walk + this.p.loopLength) / 1000;
    this.source.loopStart = start;
    this.source.loopEnd = Math.max(end, start + 0.01);
  }
}

// ---------------------------------------------------------------- data and audio

async function loadTreeData() {
  const res = await fetch("data/treedata.json");
  treeData = await res.json();
}

const sampleCache = new Map();
async function loadSample(name) {
  if (!sampleCache.has(name)) {
    const res = await fetch(`audio/${name}.mp3`);
    if (!res.ok) throw new Error(`Could not load ${name}.mp3`);
    sampleCache.set(name, await ctx.decodeAudioData(await res.arrayBuffer()));
  }
  await engine.setSample(sampleCache.get(name));
  waveform.setBuffer(sampleCache.get(name), name);
}

// ---------------------------------------------------------------- tree drawing and touch

const svg = $("tree");
const NS = "http://www.w3.org/2000/svg";
const R_PITH = 14;
const R_OUTER = 104;
const bandWidth = (R_OUTER - R_PITH) / RINGS;
const lights = [];

function ringPath(r1, r2) {
  const circle = (r, sweep) => `M ${-r} 0 A ${r} ${r} 0 1 ${sweep} ${r} 0 A ${r} ${r} 0 1 ${sweep} ${-r} 0 Z`;
  return `${circle(r2, 0)} ${circle(r1, 1)}`;
}

function drawTree() {
  // Innermost ring is the earliest year, as in a real cross-section.
  for (let i = 0; i < RINGS; i++) {
    const r1 = R_PITH + bandWidth * i;
    const band = document.createElementNS(NS, "path");
    band.setAttribute("d", ringPath(r1, r1 + bandWidth));
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
  for (let i = 0; i < RINGS; i++) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("class", "label");
    t.setAttribute("y", -(R_PITH + bandWidth * (i + 0.5)) + 2);
    t.dataset.ring = i;
    svg.append(t);
  }
}

// Ring 1 = the first year in the loaded data file (1990 for the 2019 values).
const yearFor = (i) => (treeData ? treeData.startYear + i : null);
const growthFor = (i) => (treeData ? treeData.values[i] : null);

function labelRings() {
  svg.querySelectorAll(".label").forEach((t) => (t.textContent = yearFor(+t.dataset.ring) ?? ""));
}

function ringAt(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  const d = Math.hypot(p.x, p.y);
  if (d < R_PITH || d > R_OUTER) return -1;
  return Math.min(RINGS - 1, Math.floor((d - R_PITH) / bandWidth));
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
          for (let i = 0; i < RINGS; i++) sources.serial[i] = parts[i + 1];
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
      `ring: ${year}  ·  rate ${fmt(engine.rate)}x  ·  cutoff ${Math.round(engine.cutoff)} Hz  ·  delay ${Math.round(engine.delayMs)} ms  ·  output ${isFinite(this.levelDb) ? Math.round(this.levelDb) : "-inf"} dB`;
  },
};

function animate() {
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
  if (active >= 0) {
    $("readout").textContent = `${yearFor(active)}: growth index ${growthFor(active).toFixed(2)}`;
  }
}

const paramInputs = {};
function paramValue(id) {
  return paramInputs[id] ? +paramInputs[id].value : HIDDEN[id];
}
function buildParams() {
  for (const p of PARAMS) {
    const label = document.createElement("label");
    label.textContent = p.label;
    const input = Object.assign(document.createElement("input"), { type: "range", min: p.min, max: p.max, step: p.step, value: p.value });
    const out = document.createElement("output");
    const show = () => (out.textContent = `${+(+input.value).toFixed(p.step < 1 ? 2 : 0)}${p.unit ? " " + p.unit : ""}`);
    input.addEventListener("input", () => {
      show();
      engine?.setParam(p.id, +input.value);
    });
    show();
    label.append(input, out);
    $("params").append(label);
    paramInputs[p.id] = input;
  }
}

function status(msg) {
  $("status").textContent = msg;
}

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  status("Loading…");
  try {
    ctx = new AudioContext();
    await loadTreeData();
    engine = new Engine(ctx);
    for (const p of PARAMS) engine.setParam(p.id, paramValue(p.id));
    await engine.setTreeData(treeData.values);
    await loadSample($("sound").value);
    labelRings();
    setInterval(frame, FRAME_MS);
    requestAnimationFrame(animate);
    $("start").textContent = "Running";
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
    $("start").disabled = false;
  }
});

$("demo").addEventListener("click", () => {
  const on = $("demo").getAttribute("aria-pressed") !== "true";
  $("demo").setAttribute("aria-pressed", on);
  on ? startDemo() : stopDemo();
});

$("serial").addEventListener("click", () => connectSerial().catch((err) => status(`Serial: ${err.message}`)));

$("sound").addEventListener("change", () => loadSample($("sound").value).catch((err) => status(err.message)));

drawTree();
buildParams();
