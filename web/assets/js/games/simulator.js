/**
 * Driving-test simulator.
 *
 * The player drives a generated route while an examiner watches. Breaking a
 * rule logs either a minor fault or an immediate disqualification (פסילה); the
 * run ends the moment a critical fault is committed, exactly like the real
 * test. Which rules are examined is chosen up front by topic, and the level
 * sets the tolerances and the minor-fault allowance.
 *
 * World units: 1 unit = 10 cm, so km/h = speed * 0.36.
 */

import { el, clear, pick, shuffle, randInt, clamp, fitCanvas, loop, resultScreen, levelPicker, chipGroup, toast } from '../ui.js';
import { Store } from '../store.js';

const VIEW_W = 880;
const VIEW_H = 520;
const BASE_ZOOM = 1.02;

const BLOCK = 460;
const ROAD_W = 104;
const HALF_ROAD = ROAD_W / 2;
const LANE_OFFSET = ROAD_W / 4;
const STUB = 150;              // length of the decorative cross streets
const KERB = 12;

const CAR_L = 44;
const CAR_W = 22;

const MAX_SPEED = 250;         // 90 km/h
const ACCEL = 78;
const BRAKE = 230;
const DRAG = 32;

const KMH = 0.36;

const TOPICS = [
  { id: 'lights',      label: '🚦 רמזורים' },
  { id: 'signs',       label: '🛑 תמרורי עצור ותן זכות' },
  { id: 'speed',       label: '📊 הגבלות מהירות' },
  { id: 'pedestrians', label: '🚶 הולכי רגל' },
  { id: 'traffic',     label: '🚗 תנועה נגדית' },
  { id: 'signals',     label: '↔️ איתות לפני פנייה' },
  { id: 'lanes',       label: '🛣️ שמירת נתיב' },
];

const LEVELS = [
  {
    id: 'beginner', label: 'מתחיל',
    desc: '6 ליקויים מותרים · מסלול קצר',
    legs: 6, allowance: 6, speedGrace: 12, offRoadGrace: 3.0, stopSpeed: 9, lenient: true,
  },
  {
    id: 'advanced', label: 'מתקדם',
    desc: '3 ליקויים מותרים · כל הכללים',
    legs: 9, allowance: 3, speedGrace: 7, offRoadGrace: 2.0, stopSpeed: 6, lenient: false,
  },
  {
    id: 'test', label: 'טסט אמיתי',
    desc: 'ליקוי אחד בלבד · אפס סובלנות',
    legs: 12, allowance: 1, speedGrace: 4, offRoadGrace: 1.2, stopSpeed: 4, lenient: false,
  },
];

const DIRS = [
  { c: 0, r: -1, name: 'N' },
  { c: 1, r: 0,  name: 'E' },
  { c: 0, r: 1,  name: 'S' },
  { c: -1, r: 0, name: 'W' },
];

const TURN_TEXT = { straight: 'המשך/י ישר', left: 'פנה/י שמאלה', right: 'פנה/י ימינה' };

const BUILDING_COLOURS = ['#232c3c', '#26303f', '#2a3446', '#1f2837', '#2d3748'];

/* ------------------------------------------------------------ route build */

function buildRoute(level, topics) {
  const size = 9;
  const visited = new Set();
  let cell = { c: 4, r: 7 };
  let dirIndex = 0; // heading north
  const nodes = [{ ...cell }];
  visited.add(`${cell.c},${cell.r}`);

  for (let leg = 0; leg < level.legs; leg++) {
    // Straight is tried first a little under half the time, so the route mixes
    // long legs with turns instead of collapsing into one long street.
    const options = Math.random() < 0.45
      ? [0, ...shuffle([-1, 1])]
      : [...shuffle([-1, 1]), 0];
    let moved = false;

    for (const turn of options) {
      const nextDir = (dirIndex + turn + 4) % 4;
      const d = DIRS[nextDir];
      const next = { c: cell.c + d.c, r: cell.r + d.r };
      if (next.c < 0 || next.c >= size || next.r < 0 || next.r >= size) continue;
      if (visited.has(`${next.c},${next.r}`)) continue;
      dirIndex = nextDir;
      cell = next;
      visited.add(`${next.c},${next.r}`);
      nodes.push({ ...cell });
      moved = true;
      break;
    }
    if (!moved) break;
  }

  const pos = (n) => ({ x: n.c * BLOCK, y: n.r * BLOCK });

  const segments = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = pos(nodes[i]);
    const b = pos(nodes[i + 1]);
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    segments.push({
      a, b,
      dir: { x: dx, y: dy },
      right: { x: -dy, y: dx },
      limit: topics.includes('speed') ? pick([30, 50, 50, 50, 70]) : 50,
      length: Math.hypot(b.x - a.x, b.y - a.y),
    });
  }

  const controls = [];
  if (topics.includes('lights')) controls.push('light', 'light');
  if (topics.includes('signs')) controls.push('stop', 'yield');
  if (!controls.length) controls.push('none');

  // A junction sits between two segments; the last node is the finish.
  const junctions = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const incoming = segments[i - 1];
    const outgoing = segments[i];
    const cross = incoming.dir.x * outgoing.dir.y - incoming.dir.y * outgoing.dir.x;
    const turn = cross === 0 ? 'straight' : cross > 0 ? 'right' : 'left';

    junctions.push({
      index: i,
      centre: pos(nodes[i]),
      incoming,
      outgoing,
      turn,
      control: Math.random() < 0.75 ? pick(controls) : 'none',
      phase: Math.random() * 20,
      cleared: false,
      minSpeedInZone: Infinity,
      enteredZone: false,
      signalChecked: false,
      pedestrian: topics.includes('pedestrians') && Math.random() < 0.45
        ? { t: Math.random(), active: false, done: false }
        : null,
    });
  }

  return { nodes: nodes.map(pos), segments, junctions, cells: nodes };
}

/**
 * Static street furniture: city blocks, trees, lamps and strolling pedestrians.
 * Generated once so the world is stable, and only in the blocks the route
 * actually passes, so nothing is drawn where it will never be seen.
 */
function buildScenery(route) {
  const buildings = [];
  const trees = [];
  const lamps = [];
  const walkers = [];

  const cols = route.cells.map((n) => n.c);
  const rows = route.cells.map((n) => n.r);
  const minC = Math.min(...cols) - 1;
  const maxC = Math.max(...cols);
  const minR = Math.min(...rows) - 1;
  const maxR = Math.max(...rows);

  for (let c = minC; c <= maxC; c++) {
    for (let r = minR; r <= maxR; r++) {
      const cx = c * BLOCK + BLOCK / 2;
      const cy = r * BLOCK + BLOCK / 2;
      const park = Math.random() < 0.22;

      if (park) {
        for (let k = 0; k < 7; k++) {
          trees.push({
            x: cx + (Math.random() - 0.5) * (BLOCK - 220),
            y: cy + (Math.random() - 0.5) * (BLOCK - 220),
            r: 16 + Math.random() * 9,
          });
        }
        continue;
      }

      // Two or three separate blocks per plot reads more like a street.
      const count = randInt(2, 3);
      for (let k = 0; k < count; k++) {
        const w = 90 + Math.random() * 120;
        const h = 90 + Math.random() * 120;
        buildings.push({
          x: cx + (Math.random() - 0.5) * (BLOCK - ROAD_W - w - 60),
          y: cy + (Math.random() - 0.5) * (BLOCK - ROAD_W - h - 60),
          w, h,
          colour: pick(BUILDING_COLOURS),
          lit: Math.random() < 0.55,
        });
      }
    }
  }

  for (const seg of route.segments) {
    const steps = Math.max(2, Math.round(seg.length / 105));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = seg.a.x + (seg.b.x - seg.a.x) * t;
      const y = seg.a.y + (seg.b.y - seg.a.y) * t;
      const side = i % 2 === 0 ? 1 : -1;
      const off = HALF_ROAD + KERB + 16;
      if (i % 2 === 0) {
        lamps.push({ x: x + seg.right.x * off * side, y: y + seg.right.y * off * side });
      } else {
        trees.push({ x: x + seg.right.x * off * side, y: y + seg.right.y * off * side, r: 15 + Math.random() * 6 });
      }
    }

    if (Math.random() < 0.8) {
      const t = 0.25 + Math.random() * 0.5;
      const side = Math.random() < 0.5 ? 1 : -1;
      const off = (HALF_ROAD + KERB / 2) * side;
      walkers.push({
        ox: seg.a.x + (seg.b.x - seg.a.x) * t + seg.right.x * off,
        oy: seg.a.y + (seg.b.y - seg.a.y) * t + seg.right.y * off,
        dir: seg.dir,
        phase: Math.random() * Math.PI * 2,
        span: 60 + Math.random() * 90,
        colour: pick(['#94a3b8', '#f472b6', '#38bdf8', '#facc15']),
      });
    }
  }

  return { buildings, trees, lamps, walkers };
}

/** Traffic-light state for the player's approach at time `t`. */
function lightState(junction, t) {
  const cycle = 20;
  const phase = (t + junction.phase) % cycle;
  if (phase < 9) return 'green';
  if (phase < 11.5) return 'amber';
  return 'red';
}

/* ------------------------------------------------------------------ audio */

/**
 * A tiny synthesised engine. Nothing is created until the player presses
 * "start", which doubles as the gesture browsers require before audio.
 */
function createAudio(initiallyOn) {
  let ac = null;
  let master = null;
  let engine = null;
  let sub = null;
  let engineGain = null;
  let filter = null;
  let enabled = initiallyOn;

  return {
    get enabled() { return enabled; },

    setEnabled(v) {
      enabled = v;
      if (master) master.gain.setTargetAtTime(v ? 0.5 : 0, ac.currentTime, 0.05);
    },

    start() {
      if (ac) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try { ac = new Ctor(); } catch { return; }

      master = ac.createGain();
      master.gain.value = enabled ? 0.5 : 0;
      master.connect(ac.destination);

      filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 620;
      filter.connect(master);

      engineGain = ac.createGain();
      engineGain.gain.value = 0.04;
      engineGain.connect(filter);

      engine = ac.createOscillator();
      engine.type = 'sawtooth';
      engine.frequency.value = 52;
      engine.connect(engineGain);
      engine.start();

      sub = ac.createOscillator();
      sub.type = 'triangle';
      sub.frequency.value = 26;
      sub.connect(engineGain);
      sub.start();
    },

    setSpeed(speed, throttle) {
      if (!ac || !engine) return;
      const t = ac.currentTime;
      const f = 46 + speed * 0.42;
      engine.frequency.setTargetAtTime(f, t, 0.09);
      sub.frequency.setTargetAtTime(f * 0.5, t, 0.09);
      engineGain.gain.setTargetAtTime(0.035 + (throttle ? 0.055 : 0.012), t, 0.12);
      filter.frequency.setTargetAtTime(480 + speed * 3.4, t, 0.12);
    },

    blip(freq, dur = 0.06, type = 'square', vol = 0.1) {
      if (!ac || !enabled) return;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, ac.currentTime);
      g.gain.setValueAtTime(vol, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(ac.currentTime + dur);
    },

    close() {
      try { ac?.close(); } catch { /* already gone */ }
      ac = null;
      engine = null;
    },
  };
}

/* ------------------------------------------------------------------- game */

export default {
  id: 'simulator',
  title: 'סימולטור טסט',
  icon: '🚗',
  accent: 'var(--red)',
  tagline: 'נהיגה על מסלול עם בוחן. עבירה חמורה = פסילה מיידית.',

  mount(root, api) {
    let disposed = false;
    let stop = () => {};

    showSetup();

    function showSetup() {
      stop();
      const saved = Store.extra('simulator');
      const topics = chipGroup(TOPICS, {
        multi: true,
        initial: saved.topics?.length ? saved.topics : TOPICS.map((t) => t.id),
      });
      const levels = levelPicker(LEVELS, saved.level || 'advanced');

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '🚗 סימולטור טסט' }),
          el('p', { text: 'הבוחן יושב לידך. ליקויים נצברים — עבירה חמורה מסיימת את המבחן במקום.' })),
        el('div', { class: 'card stack' },
          el('h3', { text: 'נושאים למבחן' }),
          el('p', { class: 'small muted', text: 'רק הנושאים שנבחרו ייבדקו ויופיעו במסלול.' }),
          topics,
          el('div', { class: 'divider' }),
          el('h3', { text: 'רמה' }),
          levels,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'המשך',
            onClick: () => {
              const chosen = topics.value.length ? topics.value : ['lights'];
              const level = LEVELS.find((l) => l.id === levels.value);
              Store.setExtra('simulator', { ...saved, topics: chosen, level: level.id });
              play(level, chosen);
            },
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(level, topics) {
      stop();

      const saved = Store.extra('simulator');
      const route = buildRoute(level, topics);
      const scenery = buildScenery(route);
      const start = route.segments[0];
      const audio = createAudio(saved.sound !== false);

      const car = {
        x: start.a.x + start.right.x * LANE_OFFSET,
        y: start.a.y + start.right.y * LANE_OFFSET,
        heading: Math.atan2(start.dir.y, start.dir.x),
        speed: 0,
      };

      const cam = { x: car.x, y: car.y, zoom: BASE_ZOOM };
      const skids = [];

      const input = { gas: false, brake: false, left: false, right: false };
      let signal = null;              // 'left' | 'right' | null
      let signalTick = 0;
      let elapsed = 0;
      let nextJunction = 0;
      let finished = false;
      let running = false;

      const faults = [];
      let minors = 0;
      let criticalFault = null;

      let overSpeedFor = 0;
      let offRoadFor = 0;
      let wrongLaneFor = 0;
      let crawlFor = 0;
      let skidTimer = 0;

      const others = topics.includes('traffic') ? spawnTraffic(route) : [];

      /* ------------------------------------------------------- controls */
      const CONTROLS = [
        { role: 'signal', hold: null,    press: () => setSignal('left'),  glyph: '⬅', label: 'איתות שמאלה', key: 'Z', match: (k) => k === 'z' || k === 'Z' },
        { role: 'steer',  hold: 'left',  glyph: '◀', label: 'היגוי שמאלה', key: '←', match: (k) => k === 'ArrowLeft' || k === 'a' || k === 'A' },
        { role: 'gas',    hold: 'gas',   glyph: '▲', label: 'גז',          key: '↑', match: (k) => k === 'ArrowUp' || k === 'w' || k === 'W' },
        { role: 'brake',  hold: 'brake', glyph: '▼', label: 'בלם',         key: '↓', match: (k) => k === 'ArrowDown' || k === 's' || k === 'S' },
        { role: 'steer',  hold: 'right', glyph: '▶', label: 'היגוי ימינה', key: '→', match: (k) => k === 'ArrowRight' || k === 'd' || k === 'D' },
        { role: 'signal', hold: null,    press: () => setSignal('right'), glyph: '➡', label: 'איתות ימינה', key: 'X', match: (k) => k === 'x' || k === 'X' },
      ];

      const controlBar = el('div', { class: 'control-bar' });
      CONTROLS.forEach((c) => {
        const btn = el('button', { class: 'ctrl', type: 'button', dataset: { role: c.role } },
          el('span', { class: 'c-glyph', text: c.glyph }),
          el('span', { class: 'c-label', text: c.label }),
          el('span', { class: 'c-key', text: c.key }));

        const down = (e) => {
          e.preventDefault();
          if (c.hold) { input[c.hold] = true; btn.classList.add('active'); }
          else { c.press(); }
        };
        const up = (e) => {
          e.preventDefault();
          if (c.hold) { input[c.hold] = false; btn.classList.remove('active'); }
        };
        btn.addEventListener('pointerdown', down);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointerleave', up);
        btn.addEventListener('pointercancel', up);
        c.btn = btn;
        controlBar.append(btn);
      });

      const legend = el('div', { class: 'control-legend' },
        CONTROLS.map((c) => el('div', {}, el('kbd', { text: c.key }), c.label)));

      /* ---------------------------------------------------------- layout */
      const canvas = el('canvas');
      const ctx = fitCanvas(canvas, VIEW_W, VIEW_H);

      const speedGauge = el('div', { class: 'gauge' }, el('b', { text: '0' }), el('span', { text: 'קמ״ש' }));
      const limitGauge = el('div', { class: 'gauge' }, el('b', { text: '50' }), el('span', { text: 'מותר' }));
      const instruction = el('div', { class: 'sim-instruction', text: 'צא/י לדרך' });

      const overlay = el('div', { class: 'canvas-overlay' },
        el('div', { class: 'stack center' },
          el('h2', { text: 'מוכן/ה לנסיעה?' }),
          el('p', { class: 'muted', text: 'הבוחן מתחיל למדוד ברגע שתלחצ/י. אפשר לנהוג במקלדת או בכפתורים שמתחת ללוח.' }),
          legend,
          el('button', { class: 'btn btn-green btn-lg', text: '🔑 התחל נסיעה', onClick: begin })));

      const wrap = el('div', { class: 'canvas-wrap' },
        canvas,
        el('div', { class: 'sim-gauges' }, speedGauge, limitGauge),
        instruction,
        overlay);

      const signalLamps = el('div', { class: 'signal-lamps' },
        el('i', { text: '◀' }), el('i', { text: '▶' }));

      const faultLog = el('div', { class: 'fault-log' },
        el('p', { class: 'small muted', text: 'אין ליקויים. המשך/י כך.' }));

      const minorsLine = el('b', { text: `0 / ${level.allowance}` });

      const soundBtn = el('button', {
        class: 'btn btn-sm', type: 'button',
        text: audio.enabled ? '🔊 קול' : '🔇 קול',
        onClick: () => {
          audio.setEnabled(!audio.enabled);
          soundBtn.textContent = audio.enabled ? '🔊 קול' : '🔇 קול';
          Store.setExtra('simulator', { ...Store.extra('simulator'), sound: audio.enabled });
        },
      });

      const panel = el('div', { class: 'card stack' },
        el('div', { class: 'spread' }, el('h3', { text: 'דוח הבוחן' }),
          el('span', { class: 'small muted' }, 'ליקויים: ', minorsLine)),
        el('div', { class: 'spread' },
          el('span', { class: 'small muted', text: 'איתות' }), signalLamps, soundBtn),
        el('div', { class: 'divider' }),
        faultLog);

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'sim-layout' }, el('div', { class: 'stack' }, wrap, controlBar), panel),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stop(); showSetup(); } }),
      ));

      /* ----------------------------------------------------------- input */
      function onKeyDown(e) {
        if (e.repeat) return;
        for (const c of CONTROLS) {
          if (!c.match(e.key)) continue;
          e.preventDefault();
          if (c.hold) { input[c.hold] = true; c.btn.classList.add('active'); }
          else { c.press(); }
          return;
        }
      }

      function onKeyUp(e) {
        for (const c of CONTROLS) {
          if (!c.match(e.key) || !c.hold) continue;
          e.preventDefault();
          input[c.hold] = false;
          c.btn.classList.remove('active');
          return;
        }
      }

      function setSignal(side) {
        signal = signal === side ? null : side;
        signalTick = 0;
        signalLamps.children[0].classList.toggle('on', signal === 'left');
        signalLamps.children[1].classList.toggle('on', signal === 'right');
        CONTROLS[0].btn.classList.toggle('active', signal === 'left');
        CONTROLS[5].btn.classList.toggle('active', signal === 'right');
        if (signal) audio.blip(1150, 0.05, 'square', 0.08);
      }

      /* --------------------------------------------------------- faults */
      function addFault(severity, title, detail) {
        if (finished) return;
        if (faults.some((f) => f.title === title && elapsed - f.at < 4)) return;

        const entry = { severity, title, detail, at: elapsed };
        faults.push(entry);

        if (faultLog.firstChild?.tagName === 'P') clear(faultLog);
        faultLog.prepend(el('div', { class: `fault ${severity === 'critical' ? 'critical' : ''}`.trim() },
          el('span', { class: 'f-time', text: `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}` }),
          el('span', {}, el('strong', { text: severity === 'critical' ? 'פסילה — ' : '' }), title)));

        if (severity === 'critical') {
          audio.blip(150, 0.5, 'sawtooth', 0.2);
          criticalFault = entry;
          endRun(false);
        } else {
          audio.blip(300, 0.18, 'triangle', 0.14);
          minors += 1;
          minorsLine.textContent = `${minors} / ${level.allowance}`;
          toast(`⚠️ ${title}`);
          if (minors > level.allowance) {
            criticalFault = { severity: 'critical', title: 'מספר הליקויים חרג מהמותר', detail: '', at: elapsed };
            faults.push(criticalFault);
            endRun(false);
          }
        }
      }

      /* --------------------------------------------------------- physics */
      function begin() {
        overlay.style.display = 'none';
        running = true;
        audio.start();
      }

      function step(dt) {
        if (disposed) return;
        if (!running || finished) { draw(); return; }

        elapsed += dt;

        if (input.gas) car.speed += ACCEL * dt;
        else if (input.brake) car.speed -= BRAKE * dt;
        else car.speed -= DRAG * dt;
        car.speed = clamp(car.speed, 0, MAX_SPEED);

        // Steering: the car only turns while it is actually rolling.
        const steer = (input.left ? -1 : 0) + (input.right ? 1 : 0);
        if (steer) {
          const rate = 1.6 * Math.min(1, car.speed / 30) / (1 + car.speed / 70);
          car.heading += steer * rate * dt;
        }

        car.x += Math.cos(car.heading) * car.speed * dt;
        car.y += Math.sin(car.heading) * car.speed * dt;

        // Rubber on the road when braking hard.
        skidTimer -= dt;
        if (input.brake && car.speed > 85 && skidTimer <= 0) {
          skidTimer = 0.035;
          skids.push({ x: car.x, y: car.y, h: car.heading, life: 6 });
          if (skids.length > 260) skids.shift();
        }
        for (let i = skids.length - 1; i >= 0; i--) {
          skids[i].life -= dt;
          if (skids[i].life <= 0) skids.splice(i, 1);
        }

        // Indicator ticks, so the signal is audible as well as visible.
        if (signal) {
          signalTick -= dt;
          if (signalTick <= 0) { signalTick = 0.55; audio.blip(1150, 0.04, 'square', 0.06); }
        }

        audio.setSpeed(car.speed, input.gas);

        updateCamera(dt);
        updateTraffic(dt);
        checkRules(dt);
        draw();
      }

      function updateCamera(dt) {
        const lookahead = 100 + car.speed * 0.38;
        const tx = car.x + Math.cos(car.heading) * lookahead;
        const ty = car.y + Math.sin(car.heading) * lookahead;
        const k = 1 - Math.pow(0.0015, dt);   // frame-rate independent smoothing
        cam.x += (tx - cam.x) * k;
        cam.y += (ty - cam.y) * k;
        const targetZoom = BASE_ZOOM - Math.min(0.26, car.speed * 0.00098);
        cam.zoom += (targetZoom - cam.zoom) * k;
      }

      /* ----------------------------------------------------------- rules */
      function nearestSegment() {
        let best = null;
        let bestDist = Infinity;
        for (const seg of route.segments) {
          const d = distanceToSegment(car, seg.a, seg.b);
          if (d < bestDist) { bestDist = d; best = seg; }
        }
        return { seg: best, dist: bestDist };
      }

      function onRoad() {
        for (const seg of route.segments) {
          if (distanceToSegment(car, seg.a, seg.b) <= HALF_ROAD) return true;
        }
        for (const node of route.nodes) {
          if (Math.abs(car.x - node.x) <= HALF_ROAD + STUB && Math.abs(car.y - node.y) <= HALF_ROAD) return true;
          if (Math.abs(car.y - node.y) <= HALF_ROAD + STUB && Math.abs(car.x - node.x) <= HALF_ROAD) return true;
        }
        return false;
      }

      function checkRules(dt) {
        const kmh = car.speed * KMH;
        const { seg } = nearestSegment();
        speedGauge.firstChild.textContent = String(Math.round(kmh));
        limitGauge.firstChild.textContent = String(seg?.limit ?? 50);
        speedGauge.classList.toggle('over', Boolean(seg) && kmh > seg.limit + level.speedGrace);

        if (topics.includes('speed') && seg) {
          if (kmh > seg.limit + level.speedGrace) {
            overSpeedFor += dt;
            if (kmh > seg.limit + 25) {
              addFault('critical', `חריגת מהירות חמורה (${Math.round(kmh)} במקום ${seg.limit})`,
                'חריגה של יותר מ-25 קמ״ש מעל המותר היא עבירה פוסלת.');
            } else if (overSpeedFor > 1.5) {
              overSpeedFor = 0;
              addFault('minor', `חריגת מהירות (${Math.round(kmh)} במקום ${seg.limit})`,
                'המהירות המרבית נקבעת לפי התמרור, ובהיעדרו לפי סוג הדרך.');
            }
          } else {
            overSpeedFor = Math.max(0, overSpeedFor - dt);
          }
        }

        if (!onRoad()) {
          offRoadFor += dt;
          if (offRoadFor > level.offRoadGrace) {
            addFault('critical', 'ירידה מהכביש', 'איבוד שליטה ויציאה משטח הדרך הסלולה.');
          } else if (offRoadFor > 0.4) {
            addFault('minor', 'גלישה משולי הכביש', 'שמור/י על הרכב בתוך הנתיב.');
          }
        } else {
          offRoadFor = 0;
        }

        if (topics.includes('lanes') && seg && car.speed > 20 && !insideAnyJunction()) {
          const toCar = { x: car.x - seg.a.x, y: car.y - seg.a.y };
          const side = toCar.x * seg.right.x + toCar.y * seg.right.y;
          const facing = Math.cos(car.heading) * seg.dir.x + Math.sin(car.heading) * seg.dir.y;

          if (facing < -0.4) {
            addFault('critical', 'נסיעה נגד כיוון התנועה', 'הרכב נוסע בניגוד לכיוון הנסיעה המותר בנתיב.');
          } else if (side < -6) {
            wrongLaneFor += dt;
            if (wrongLaneFor > 1.6) {
              wrongLaneFor = 0;
              addFault('minor', 'נסיעה בנתיב הנגדי', 'יש לנסוע בנתיב הימני, קרוב ככל האפשר לשפת הכביש הימנית.');
            }
          } else {
            wrongLaneFor = 0;
          }
        }

        if (!level.lenient && seg && kmh < 8 && onRoad() && !nearAnyStopRequirement()) {
          crawlFor += dt;
          if (crawlFor > 7) {
            crawlFor = 0;
            addFault('minor', 'נסיעה איטית מדי', 'נסיעה איטית ללא סיבה מפריעה לתנועה ומהווה ליקוי.');
          }
        } else {
          crawlFor = 0;
        }

        const junction = route.junctions[nextJunction];
        if (junction) handleJunction(junction, dt, kmh);

        for (const other of others) {
          if (Math.hypot(other.x - car.x, other.y - car.y) < 34) {
            addFault('critical', 'תאונה — פגיעה ברכב אחר', 'מגע עם רכב אחר הוא כישלון מיידי במבחן.');
            return;
          }
        }

        const last = route.nodes[route.nodes.length - 1];
        if (Math.hypot(car.x - last.x, car.y - last.y) < 70) endRun(true);
      }

      function insideAnyJunction() {
        return route.nodes.some((n) => Math.abs(car.x - n.x) < HALF_ROAD + 12 && Math.abs(car.y - n.y) < HALF_ROAD + 12);
      }

      function nearAnyStopRequirement() {
        const j = route.junctions[nextJunction];
        if (!j) return false;
        const d = Math.hypot(car.x - j.centre.x, car.y - j.centre.y);
        if (d > 220) return false;
        if (j.control === 'stop' || j.control === 'yield') return true;
        if (j.control === 'light' && lightState(j, elapsed) !== 'green') return true;
        return Boolean(j.pedestrian?.active);
      }

      /** Signed distance from the car to the junction's stop line, along the approach. */
      function distanceToStopLine(j) {
        const d = j.incoming.dir;
        const stopX = j.centre.x - d.x * HALF_ROAD;
        const stopY = j.centre.y - d.y * HALF_ROAD;
        return (stopX - car.x) * d.x + (stopY - car.y) * d.y;
      }

      function handleJunction(j, dt, kmh) {
        const gap = distanceToStopLine(j);

        if (j.pedestrian && !j.pedestrian.done) {
          if (!j.pedestrian.active && gap < 240 && gap > 0) j.pedestrian.active = true;
          if (j.pedestrian.active) {
            j.pedestrian.t += dt * 0.28;
            if (j.pedestrian.t > 1.6) { j.pedestrian.active = false; j.pedestrian.done = true; }
          }
        }

        if (gap < 90 && gap > -HALF_ROAD * 2) {
          j.enteredZone = true;
          j.minSpeedInZone = Math.min(j.minSpeedInZone, kmh);
        }

        if (topics.includes('signals') && j.turn !== 'straight' && !j.signalChecked && gap < 140 && gap > 20) {
          if (signal === j.turn) j.signalChecked = 'ok';
        }

        if (gap > 0) return;
        if (j.cleared) return;
        j.cleared = true;

        if (j.control === 'light') {
          const state = lightState(j, elapsed);
          if (state === 'red') {
            addFault('critical', 'עברת באור אדום', 'חציית קו העצירה באור אדום היא מהעבירות החמורות ביותר.');
            return;
          }
          if (state === 'amber' && kmh > 25 && !level.lenient) {
            addFault('minor', 'חצית באור צהוב', 'באור צהוב יש לעצור אם ניתן לעשות זאת בבטחה.');
          }
        }

        if (j.control === 'stop' && j.minSpeedInZone > level.stopSpeed) {
          addFault('critical', 'לא עצרת בתמרור "עצור"',
            'תמרור עצור מחייב עצירה מוחלטת — הרכב חייב לעמוד לגמרי לפני קו העצירה.');
          return;
        }

        if (j.control === 'yield' && j.minSpeedInZone > 25) {
          addFault('minor', 'לא האטת בתמרור "תן זכות קדימה"',
            'התמרור מחייב האטה ובדיקה, וכניסה לצומת רק כשהדרך פנויה.');
        }

        if (j.pedestrian?.active) {
          addFault('critical', 'פגיעה בהולך רגל במעבר חצייה',
            'הולך רגל במעבר חצייה מקבל זכות קדימה מוחלטת.');
          return;
        }

        if (topics.includes('signals') && j.turn !== 'straight' && j.signalChecked !== 'ok') {
          addFault('minor', `לא איתתת לפני פנייה ${j.turn === 'left' ? 'שמאלה' : 'ימינה'}`,
            'יש לאותת בזמן, לפני תחילת הפנייה, כדי להודיע על הכוונה.');
        }

        if (signal) setSignal(signal);   // cancel the indicator after the turn
        nextJunction += 1;
      }

      /* ------------------------------------------------------- other cars */
      function spawnTraffic(rt) {
        const cars = [];
        rt.segments.forEach((seg, i) => {
          if (i === 0 || Math.random() > 0.7) return;
          const t = 0.35 + Math.random() * 0.4;
          const baseSpeed = 70 + Math.random() * 50;
          cars.push({
            x: seg.a.x + (seg.b.x - seg.a.x) * t - seg.right.x * LANE_OFFSET,
            y: seg.a.y + (seg.b.y - seg.a.y) * t - seg.right.y * LANE_OFFSET,
            vx: -seg.dir.x, vy: -seg.dir.y,
            speed: baseSpeed,
            baseSpeed,
            braking: false,
            colour: pick(['#64748b', '#a855f7', '#0ea5e9', '#f97316']),
            seg,
          });
        });
        return cars;
      }

      function updateTraffic(dt) {
        for (const o of others) {
          // Oncoming traffic obeys the same signals the player does.
          let target = o.baseSpeed;
          for (const j of route.junctions) {
            const dx = j.centre.x - o.x;
            const dy = j.centre.y - o.y;
            const ahead = dx * o.vx + dy * o.vy;
            const lateral = Math.abs(dx * -o.vy + dy * o.vx);
            if (ahead <= 0 || ahead > 230 || lateral > HALF_ROAD) continue;
            if (j.control === 'light' && lightState(j, elapsed) !== 'green') target = 0;
            else if (j.control === 'stop' && ahead < 110) target = 0;
            else if (j.control === 'yield' && ahead < 110) target = Math.min(target, 25);
          }

          o.braking = target < o.speed - 4;
          o.speed += clamp(target - o.speed, -190 * dt, 95 * dt);
          o.x += o.vx * o.speed * dt;
          o.y += o.vy * o.speed * dt;

          const beyond = (o.x - o.seg.a.x) * o.seg.dir.x + (o.y - o.seg.a.y) * o.seg.dir.y;
          if (beyond < -260) {
            o.x = o.seg.b.x - o.seg.right.x * LANE_OFFSET;
            o.y = o.seg.b.y - o.seg.right.y * LANE_OFFSET;
          }
        }
      }

      /* ------------------------------------------------------------ draw */
      function draw() {
        ctx.save();
        ctx.fillStyle = '#16281b';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        const shake = car.speed > 190 ? (car.speed - 190) * 0.012 : 0;
        ctx.translate(VIEW_W / 2 + (Math.random() - 0.5) * shake, VIEW_H / 2 + (Math.random() - 0.5) * shake);
        ctx.scale(cam.zoom, cam.zoom);
        ctx.translate(-cam.x, -cam.y);

        drawBlocks();
        drawRoads();
        drawSkids();
        drawJunctions();
        drawFinish();
        drawScenery();

        for (const o of others) drawCar(o.x, o.y, Math.atan2(o.vy, o.vx), o.colour, false, o.braking);
        drawCar(car.x, car.y, car.heading, '#22c55e', true, input.brake);

        ctx.restore();
        updateInstruction();
      }

      function drawBlocks() {
        for (const b of scenery.buildings) {
          ctx.fillStyle = 'rgba(0,0,0,.35)';
          ctx.fillRect(b.x - b.w / 2 + 7, b.y - b.h / 2 + 9, b.w, b.h);
          ctx.fillStyle = b.colour;
          ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
          ctx.strokeStyle = 'rgba(148,163,184,.22)';
          ctx.lineWidth = 2;
          ctx.strokeRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
          if (b.lit) {
            ctx.fillStyle = 'rgba(253,224,71,.16)';
            for (let wx = b.x - b.w / 2 + 12; wx < b.x + b.w / 2 - 14; wx += 26) {
              for (let wy = b.y - b.h / 2 + 12; wy < b.y + b.h / 2 - 14; wy += 26) {
                ctx.fillRect(wx, wy, 12, 12);
              }
            }
          }
        }
      }

      function drawRoads() {
        // Pavement (kerb to kerb) sits under the asphalt so edges read cleanly.
        ctx.fillStyle = '#4a5468';
        for (const node of route.nodes) {
          ctx.fillRect(node.x - HALF_ROAD - STUB - KERB, node.y - HALF_ROAD - KERB, ROAD_W + (STUB + KERB) * 2, ROAD_W + KERB * 2);
          ctx.fillRect(node.x - HALF_ROAD - KERB, node.y - HALF_ROAD - STUB - KERB, ROAD_W + KERB * 2, ROAD_W + (STUB + KERB) * 2);
        }
        for (const seg of route.segments) {
          ctx.fillRect(
            Math.min(seg.a.x, seg.b.x) - HALF_ROAD - KERB,
            Math.min(seg.a.y, seg.b.y) - HALF_ROAD - KERB,
            Math.abs(seg.b.x - seg.a.x) + ROAD_W + KERB * 2,
            Math.abs(seg.b.y - seg.a.y) + ROAD_W + KERB * 2,
          );
        }

        ctx.fillStyle = '#2b3242';   // cross streets the route does not use
        for (const node of route.nodes) {
          ctx.fillRect(node.x - HALF_ROAD - STUB, node.y - HALF_ROAD, ROAD_W + STUB * 2, ROAD_W);
          ctx.fillRect(node.x - HALF_ROAD, node.y - HALF_ROAD - STUB, ROAD_W, ROAD_W + STUB * 2);
        }

        ctx.fillStyle = '#3a4152';   // the route itself
        for (const seg of route.segments) {
          ctx.fillRect(
            Math.min(seg.a.x, seg.b.x) - HALF_ROAD,
            Math.min(seg.a.y, seg.b.y) - HALF_ROAD,
            Math.abs(seg.b.x - seg.a.x) + ROAD_W,
            Math.abs(seg.b.y - seg.a.y) + ROAD_W,
          );
        }

        ctx.strokeStyle = 'rgba(248,250,252,.55)';
        ctx.lineWidth = 3;
        ctx.setLineDash([26, 22]);
        for (const seg of route.segments) {
          ctx.beginPath();
          ctx.moveTo(seg.a.x, seg.a.y);
          ctx.lineTo(seg.b.x, seg.b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      function drawSkids() {
        ctx.fillStyle = 'rgba(15,18,24,.5)';
        for (const s of skids) {
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.rotate(s.h);
          ctx.globalAlpha = Math.min(1, s.life / 6) * 0.6;
          ctx.fillRect(-6, -CAR_W / 2 + 2, 12, 4);
          ctx.fillRect(-6, CAR_W / 2 - 6, 12, 4);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      function drawScenery() {
        for (const t of scenery.trees) {
          ctx.fillStyle = 'rgba(0,0,0,.3)';
          ctx.beginPath(); ctx.arc(t.x + 3, t.y + 4, t.r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#166534';
          ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#15803d';
          ctx.beginPath(); ctx.arc(t.x - t.r * 0.25, t.y - t.r * 0.25, t.r * 0.6, 0, Math.PI * 2); ctx.fill();
        }

        for (const l of scenery.lamps) {
          ctx.fillStyle = 'rgba(253,224,71,.08)';
          ctx.beginPath(); ctx.arc(l.x, l.y, 46, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#cbd5e1';
          ctx.beginPath(); ctx.arc(l.x, l.y, 4.5, 0, Math.PI * 2); ctx.fill();
        }

        for (const w of scenery.walkers) {
          const t = Math.sin(elapsed * 0.55 + w.phase);
          const x = w.ox + w.dir.x * t * w.span;
          const y = w.oy + w.dir.y * t * w.span;
          const bob = Math.sin(elapsed * 7 + w.phase) * 1.4;
          ctx.fillStyle = w.colour;
          ctx.beginPath(); ctx.arc(x, y - 7 + bob, 5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.roundRect(x - 4, y - 1 + bob, 8, 12, 3); ctx.fill();
        }
      }

      function drawJunctions() {
        route.junctions.forEach((j, i) => {
          const d = j.incoming.dir;
          const sx = j.centre.x - d.x * HALF_ROAD;
          const sy = j.centre.y - d.y * HALF_ROAD;

          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(sx - j.incoming.right.x * HALF_ROAD, sy - j.incoming.right.y * HALF_ROAD);
          ctx.lineTo(sx, sy);
          ctx.stroke();

          ctx.fillStyle = 'rgba(226,232,240,.85)';
          for (let k = 0; k < 5; k++) {
            const off = -HALF_ROAD + 6 + k * 10;
            const px = sx - d.x * 26 + j.incoming.right.x * off;
            const py = sy - d.y * 26 + j.incoming.right.y * off;
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(Math.atan2(d.y, d.x));
            ctx.fillRect(-14, -3.5, 28, 7);
            ctx.restore();
          }

          const signX = sx + j.incoming.right.x * (HALF_ROAD + 26);
          const signY = sy + j.incoming.right.y * (HALF_ROAD + 26);

          if (j.control === 'light') {
            const state = lightState(j, elapsed);
            ctx.fillStyle = '#0b0f16';
            ctx.fillRect(signX - 9, signY - 26, 18, 52);
            const lamp = (dy, colour, on) => {
              if (on) { ctx.shadowColor = colour; ctx.shadowBlur = 14; }
              ctx.fillStyle = on ? colour : '#1e293b';
              ctx.beginPath();
              ctx.arc(signX, signY + dy, 6, 0, Math.PI * 2);
              ctx.fill();
              ctx.shadowBlur = 0;
            };
            lamp(-15, '#ef4444', state === 'red');
            lamp(0, '#f59e0b', state === 'amber');
            lamp(15, '#22c55e', state === 'green');
          } else if (j.control === 'stop') {
            ctx.fillStyle = '#dc2626';
            ctx.beginPath();
            ctx.arc(signX, signY, 17, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 13px Rubik, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('עצור', signX, signY);
          } else if (j.control === 'yield') {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(signX, signY + 16);
            ctx.lineTo(signX - 18, signY - 14);
            ctx.lineTo(signX + 18, signY - 14);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }

          if (topics.includes('speed')) {
            const lx = j.centre.x + j.outgoing.dir.x * 130 + j.outgoing.right.x * (HALF_ROAD + 26);
            const ly = j.centre.y + j.outgoing.dir.y * 130 + j.outgoing.right.y * (HALF_ROAD + 26);
            ctx.beginPath();
            ctx.arc(lx, ly, 16, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.fillStyle = '#0b0f16';
            ctx.font = 'bold 14px Rubik, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(j.outgoing.limit), lx, ly);
          }

          if (j.pedestrian?.active) {
            const t = clamp(j.pedestrian.t, 0, 1.6) / 1.6;
            const px = sx - d.x * 26 + j.incoming.right.x * (HALF_ROAD - t * ROAD_W * 1.15);
            const py = sy - d.y * 26 + j.incoming.right.y * (HALF_ROAD - t * ROAD_W * 1.15);
            const bob = Math.sin(elapsed * 8) * 1.5;
            ctx.fillStyle = '#fbbf24';
            ctx.beginPath(); ctx.arc(px, py - 7 + bob, 6, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.roundRect(px - 5, py - 1 + bob, 10, 15, 4); ctx.fill();
          }

          // Turn guidance painted on the junction the player is heading for.
          if (i === nextJunction) {
            ctx.save();
            ctx.globalAlpha = 0.35 + Math.sin(elapsed * 4) * 0.12;
            ctx.fillStyle = '#3b82f6';
            ctx.beginPath();
            ctx.arc(j.centre.x, j.centre.y, 34, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            const outAngle = Math.atan2(j.outgoing.dir.y, j.outgoing.dir.x);
            ctx.save();
            ctx.translate(j.centre.x, j.centre.y);
            ctx.rotate(outAngle);
            ctx.strokeStyle = '#dbeafe';
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(-18, 0); ctx.lineTo(14, 0);
            ctx.moveTo(4, -10); ctx.lineTo(16, 0); ctx.lineTo(4, 10);
            ctx.stroke();
            ctx.restore();
          }
        });
      }

      function drawFinish() {
        const last = route.nodes[route.nodes.length - 1];
        // Chequered pad rather than a flat disc, so the goal reads instantly.
        for (let gx = -3; gx < 3; gx++) {
          for (let gy = -3; gy < 3; gy++) {
            ctx.fillStyle = (gx + gy) % 2 === 0 ? '#e2e8f0' : '#0b0f16';
            ctx.fillRect(last.x + gx * 16, last.y + gy * 16, 16, 16);
          }
        }
        ctx.fillStyle = '#22c55e';
        ctx.font = 'bold 20px Rubik, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('סיום', last.x, last.y - 70);
      }

      function drawCar(x, y, heading, colour, isPlayer, braking) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(heading);

        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.beginPath(); ctx.roundRect(-CAR_L / 2 + 3, -CAR_W / 2 + 4, CAR_L, CAR_W, 6); ctx.fill();

        ctx.fillStyle = colour;
        ctx.beginPath(); ctx.roundRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W, 6); ctx.fill();

        ctx.fillStyle = 'rgba(203,213,225,.9)';
        ctx.beginPath(); ctx.roundRect(2, -CAR_W / 2 + 3, 12, CAR_W - 6, 3); ctx.fill();
        ctx.fillStyle = 'rgba(203,213,225,.5)';
        ctx.beginPath(); ctx.roundRect(-13, -CAR_W / 2 + 3, 8, CAR_W - 6, 3); ctx.fill();

        // Headlights forward, brake lights aft.
        ctx.fillStyle = '#fde68a';
        ctx.fillRect(CAR_L / 2 - 3, -CAR_W / 2 + 2, 3, 5);
        ctx.fillRect(CAR_L / 2 - 3, CAR_W / 2 - 7, 3, 5);

        if (braking) {
          ctx.shadowColor = '#ef4444';
          ctx.shadowBlur = 12;
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(-CAR_L / 2, -CAR_W / 2 + 2, 3, 5);
          ctx.fillRect(-CAR_L / 2, CAR_W / 2 - 7, 3, 5);
          ctx.shadowBlur = 0;
        }

        if (isPlayer && signal && Math.floor(elapsed * 2.4) % 2 === 0) {
          ctx.shadowColor = '#f59e0b';
          ctx.shadowBlur = 10;
          ctx.fillStyle = '#f59e0b';
          const sy = signal === 'left' ? -CAR_W / 2 : CAR_W / 2 - 5;
          ctx.fillRect(-CAR_L / 2 + 1, sy, 8, 5);
          ctx.fillRect(CAR_L / 2 - 9, sy, 8, 5);
          ctx.shadowBlur = 0;
        }

        ctx.restore();
      }

      function updateInstruction() {
        const j = route.junctions[nextJunction];
        if (!j) {
          const last = route.nodes[route.nodes.length - 1];
          const d = Math.round(Math.hypot(car.x - last.x, car.y - last.y) / 10);
          instruction.textContent = `🏁 סיום המסלול · ${d} מ׳`;
          return;
        }
        const metres = Math.max(0, Math.round(distanceToStopLine(j) / 10));
        const arrow = j.turn === 'left' ? '↰' : j.turn === 'right' ? '↱' : '↑';
        const control = j.control === 'light'
          ? ` · רמזור ${{ red: '🔴', amber: '🟡', green: '🟢' }[lightState(j, elapsed)]}`
          : j.control === 'stop' ? ' · 🛑 עצור'
          : j.control === 'yield' ? ' · תן זכות קדימה' : '';
        instruction.textContent = `${arrow} ${TURN_TEXT[j.turn]} בעוד ${metres} מ׳${control}`;
      }

      /* ------------------------------------------------------------- end */
      function endRun(passed) {
        if (finished) return;
        finished = true;
        running = false;
        stop();

        const base = 100 - minors * 8;
        const score = passed ? Math.max(10, Math.round(base * 10)) : 0;

        if (passed && level.id === 'test') Store.award('passed_test');
        if (passed && faults.length === 0) Store.award('clean_sheet');

        const outcome = Store.finishRun('simulator', {
          score,
          xp: passed ? 60 + Math.max(0, (level.allowance - minors)) * 15 : 10,
          label: level.label,
          passed,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        const report = faults.length
          ? el('div', { class: 'card stack' },
              el('h3', { text: 'פירוט הליקויים' }),
              ...faults.map((f) => el('div', { class: `feedback ${f.severity === 'critical' ? 'bad' : ''}`.trim() },
                el('strong', { text: `${f.severity === 'critical' ? '⛔ פסילה — ' : '⚠️ ליקוי — '}${f.title}` }),
                el('span', { text: f.detail }))))
          : el('div', { class: 'card' }, el('p', { class: 'center', text: '✨ נסיעה נקייה לחלוטין — אף ליקוי אחד.' }));

        clear(root).append(resultScreen({
          title: passed ? 'עברת את הטסט' : criticalFault ? 'נפסלת' : 'לא עברת',
          emoji: passed ? '🎓' : '⛔',
          score,
          passed,
          stats: [
            ['ליקויים', `${minors} / ${level.allowance}`],
            ['זמן נסיעה', `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`],
            ['צמתים', `${Math.min(nextJunction, route.junctions.length)}/${route.junctions.length}`],
            ['רמה', level.label],
          ],
          detail: report,
          outcome,
          onReplay: () => play(level, topics),
          onHome: api.home,
        }));
      }

      /* ---------------------------------------------------------- wiring */
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      const cancel = loop(step);

      stop = () => {
        cancel();
        audio.close();
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
      };

      draw();
    }

    return () => { disposed = true; stop(); };
  },
};

/* ------------------------------------------------------------- geometry */

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
