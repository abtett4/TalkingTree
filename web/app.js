// Talking Tree, web version: the 2019 Max/MSP patch rebuilt in plain Web Audio.

const RINGS = 5;
const FRAME_MS = 66; // the Arduino sketch prints roughly every 60-80 ms

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
    this.delay.connect(this.wet).connect(this.filter).connect(ctx.destination);
    this.dry.connect(ctx.destination);
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
    this.step();
  }
  async setTreeData(values) {
    this.data = values;
  }
  setRings(values) {
    const thr = this.p.threshold;
    values.forEach((v, i) => {
      const on = v >= thr;
      if (on === this.touched[i]) return;
      this.touched[i] = on;
      // Quirk 1 kept: every ring writes the same rate and metro, so the last change wins.
      if (on) {
        const g = this.data[this.p.yearOffset + i];
        if (g !== undefined) {
          this.setRate(scaleClip(g, this.p.dataMin, this.p.dataMax, 0.5, 1.5));
          this.filter.frequency.setTargetAtTime(scaleClip(g, this.p.dataMin, this.p.dataMax, 50, 10000), this.ctx.currentTime, 0.01);
        }
        this.startMetro();
      } else {
        this.setRate(0);
        this.stopMetro(); // quirk 4 fixed: the interval is left alone
      }
    });
    // Quirk 3 fixed: strongest held ring sets the delay time, smoothed.
    const held = values.filter((v) => v >= thr);
    if (held.length) {
      const ms = scaleClip(Math.max(...held), thr, 2000, 100, 1000);
      this.delay.delayTime.setTargetAtTime(ms / 1000, this.ctx.currentTime, 0.03);
    }
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

// A held ring ramps from a light touch to a firm one over ~2 s, like squeezing the real sensor.
let pointerRing = -1;
let pointerDown = 0;
svg.addEventListener("pointerdown", (e) => {
  if (!engine) return;
  pointerRing = ringAt(e);
  pointerDown = performance.now();
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener("pointermove", (e) => {
  if (pointerRing < 0) return;
  const r = ringAt(e);
  if (r >= 0 && r !== pointerRing) {
    pointerRing = r;
    pointerDown = performance.now();
  }
});
const release = () => (pointerRing = -1);
svg.addEventListener("pointerup", release);
svg.addEventListener("pointercancel", release);

function updatePointer() {
  sources.pointer.fill(0);
  if (pointerRing >= 0) {
    const held = (performance.now() - pointerDown) / 2000;
    sources.pointer[pointerRing] = Math.round(700 + Math.min(1, held) * 1300);
  }
}

// ---------------------------------------------------------------- demo mode

let demoTimer = null;
let demoRamp = null;
function startDemo() {
  const next = () => {
    sources.demo.fill(0);
    const ring = Math.floor(Math.random() * RINGS);
    const hold = 1200 + Math.random() * 2500;
    const t0 = performance.now();
    demoRamp = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / hold);
      sources.demo[ring] = Math.round(650 + Math.sin(k * Math.PI) * 1300);
    }, FRAME_MS);
    demoTimer = setTimeout(() => {
      clearInterval(demoRamp);
      sources.demo.fill(0);
      demoTimer = setTimeout(next, 400 + Math.random() * 1600);
    }, hold);
  };
  next();
}
function stopDemo() {
  clearInterval(demoRamp);
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
