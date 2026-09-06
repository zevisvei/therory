/**
 * "Who goes first?" — right-of-way drill on a generated SVG junction.
 *
 * Geometry follows right-hand traffic (Israel): a vehicle travelling north uses
 * x=225, south x=175, east y=225, west y=175. Every scenario is authored once
 * and then rotated in quarter turns, which preserves both the give-way-to-your-
 * right rule and every sign-based rule, so one scenario yields four layouts.
 */

import { el, clear, shuffle, randInt, hudItem, resultScreen, levelPicker, toast } from '../ui.js';
import { Store } from '../store.js';

const DIRS = ['N', 'E', 'S', 'W'];
const rotateDir = (dir, turns) => DIRS[(DIRS.indexOf(dir) + turns) % 4];

/** Where a vehicle waits, and which way its sprite points (0 = pointing up). */
const APPROACH = {
  S: { x: 225, y: 302, rot: 0 },
  N: { x: 175, y: 98,  rot: 180 },
  W: { x: 98,  y: 225, rot: 90 },
  E: { x: 302, y: 175, rot: 270 },
};

/** Signs sit on the driver's right-hand kerb. */
const SIGN_POS = {
  S: { x: 270, y: 290 },
  N: { x: 130, y: 110 },
  W: { x: 110, y: 270 },
  E: { x: 290, y: 130 },
};

/** Manoeuvre paths, keyed by approach then intent. */
const PATHS = {
  S: {
    straight: 'M225,286 L225,118',
    right:    'M225,286 L225,240 Q225,225 240,225 L292,225',
    left:     'M225,286 L225,215 Q225,175 185,175 L108,175',
  },
  N: {
    straight: 'M175,114 L175,282',
    right:    'M175,114 L175,160 Q175,175 160,175 L108,175',
    left:     'M175,114 L175,185 Q175,225 215,225 L292,225',
  },
  W: {
    straight: 'M114,225 L282,225',
    right:    'M114,225 L160,225 Q175,225 175,240 L175,292',
    left:     'M114,225 L185,225 Q225,225 225,185 L225,108',
  },
  E: {
    straight: 'M286,175 L118,175',
    right:    'M286,175 L240,175 Q225,175 225,160 L225,108',
    left:     'M286,175 L215,175 Q175,175 175,215 L175,292',
  },
};

/** Ring travel order — island stays on the driver's left. */
const RING_ORDER = ['S', 'E', 'N', 'W'];
const RING_ANGLE = { S: 90, E: 0, N: -90, W: 180 };
const RING_R = 68;

const ACTOR_COLOURS = ['#3b82f6', '#f59e0b', '#a855f7', '#14b8a6', '#f43f5e'];

/* ------------------------------------------------------------- scenarios */

const SCENARIOS = [
  {
    id: 'right-rule',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true },
      { from: 'E', to: 'straight', kind: 'car' },
    ],
    answer: 1,
    explain: 'צומת ללא תמרורים. הרכב שמגיע מימינך זכאי לזכות קדימה — אתה נותן לו לעבור ראשון.',
  },
  {
    id: 'left-yields',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true },
      { from: 'W', to: 'straight', kind: 'car' },
    ],
    answer: 0,
    explain: 'הרכב השני מגיע משמאלך. בצומת לא מתומרר זכות הקדימה שלך — אתה עובר ראשון.',
  },
  {
    id: 'stop-sign',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true, sign: 'stop' },
      { from: 'W', to: 'straight', kind: 'car' },
    ],
    answer: 1,
    explain: 'תמרור "עצור" מחייב אותך לעצור עצירה מוחלטת ולתת זכות קדימה לכל התנועה בדרך החוצה — גם למי שמגיע משמאל.',
  },
  {
    id: 'yield-sign',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true, sign: 'yield' },
      { from: 'E', to: 'straight', kind: 'truck' },
    ],
    answer: 1,
    explain: 'תמרור "תן זכות קדימה" — אינך חייב לעצור אם הדרך פנויה, אבל כאן המשאית חוצה ולכן היא עוברת ראשונה.',
  },
  {
    id: 'oncoming-left',
    type: 'cross',
    actors: [
      { from: 'S', to: 'left', kind: 'car', you: true },
      { from: 'N', to: 'straight', kind: 'car' },
    ],
    answer: 1,
    explain: 'פנייה שמאלה חוצה את נתיב התנועה הנגדית. הרכב הממשיך ישר ממול עובר ראשון.',
  },
  {
    id: 'straight-beats-left',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true },
      { from: 'N', to: 'left', kind: 'car' },
    ],
    answer: 0,
    explain: 'אתה ממשיך ישר; הרכב ממול פונה שמאלה וחוצה את נתיבך. הישר קודם.',
  },
  {
    id: 'right-turn-vs-cross',
    type: 'cross',
    actors: [
      { from: 'S', to: 'right', kind: 'car', you: true },
      { from: 'E', to: 'straight', kind: 'car' },
    ],
    answer: 1,
    explain: 'גם בפנייה ימינה אתה נכנס לנתיב שהרכב מימין כבר נוסע בו. הוא קודם.',
  },
  {
    id: 'ambulance',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true },
      { from: 'W', to: 'straight', kind: 'ambulance', siren: true },
    ],
    answer: 1,
    explain: 'רכב ביטחון או הצלה עם סירנה ואורות מהבהבים מקבל זכות קדימה תמיד — פנה לו דרך גם אם הזכות שלך.',
  },
  {
    id: 'pedestrian',
    type: 'cross',
    actors: [
      { from: 'S', to: 'right', kind: 'car', you: true },
      { at: 'E', kind: 'ped' },
    ],
    answer: 1,
    explain: 'בפנייה אתה חוצה מעבר חצייה. הולך הרגל שכבר במעבר עובר ראשון — עצור לפניו.',
  },
  {
    id: 'lights-green',
    type: 'cross',
    control: 'light',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true, light: 'red' },
      { from: 'W', to: 'straight', kind: 'car', light: 'green' },
    ],
    answer: 1,
    explain: 'הרמזור גובר על כלל זכות הקדימה. לך אור אדום — הרכב עם הירוק עובר.',
  },
  {
    id: 'lights-flash',
    type: 'cross',
    control: 'light',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true, light: 'flash' },
      { from: 'E', to: 'straight', kind: 'car', light: 'flash' },
    ],
    answer: 1,
    explain: 'צהוב מהבהב = הרמזור אינו מכוון את התנועה. הצומת חוזר להיות צומת רגיל, וזכות הקדימה למי שמימין.',
  },
  {
    id: 'both-stop',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true, sign: 'stop' },
      { from: 'E', to: 'straight', kind: 'car', sign: 'stop' },
    ],
    answer: 1,
    explain: 'שני הכיוונים עוצרים. אחרי העצירה חוזרים לכלל הרגיל — הרכב שמימין ממשיך ראשון.',
  },
  {
    id: 't-through',
    type: 'T', missing: 'N',
    actors: [
      { from: 'S', to: 'right', kind: 'car', you: true },
      { from: 'E', to: 'straight', kind: 'bus' },
    ],
    answer: 1,
    explain: 'אתה מגיע מזרוע המאונכת של צומת T ונכנס לדרך הראשית. התנועה בדרך הישרה עוברת ראשונה.',
  },
  {
    id: 't-priority',
    type: 'T', missing: 'S',
    actors: [
      { from: 'W', to: 'straight', kind: 'car', you: true },
      { from: 'N', to: 'left', kind: 'car' },
    ],
    answer: 0,
    explain: 'אתה נוסע בדרך הישרה; הרכב השני יוצא מזרוע הצומת ופונה לתוך נתיבך. הוא נותן לך זכות קדימה.',
  },
  {
    id: 'roundabout-inside',
    type: 'roundabout',
    actors: [
      { from: 'S', to: 'ring', kind: 'car', you: true, exit: 'N' },
      { ring: 'W', to: 'ring', kind: 'car', exit: 'E' },
    ],
    answer: 1,
    explain: 'בכיכר, הרכב שכבר נמצא בתוך הכיכר קודם. הוא מגיע משמאלך — עצור בכניסה ותן לו לעבור.',
  },
  {
    id: 'roundabout-passed',
    type: 'roundabout',
    actors: [
      { from: 'S', to: 'ring', kind: 'car', you: true, exit: 'N' },
      { ring: 'E', to: 'ring', kind: 'car', exit: 'N' },
    ],
    answer: 0,
    explain: 'הרכב שבכיכר כבר חלף על פני הכניסה שלך ומתרחק ממנה — הוא אינו חוסם אותך. נותנים זכות קדימה רק לתנועה שמתקרבת מצד שמאל. אתה נכנס.',
  },
  {
    id: 'three-way',
    type: 'cross',
    actors: [
      { from: 'S', to: 'straight', kind: 'car', you: true },
      { from: 'E', to: 'straight', kind: 'car' },
      { from: 'W', to: 'straight', kind: 'car' },
    ],
    answer: 1,
    explain: 'שלושה רכבים בצומת לא מתומרר. הרכב שמימינך אינו חייב זכות קדימה לאיש — הוא נכנס ראשון, אחריו אתה, ולבסוף זה שמשמאל.',
  },
  {
    id: 'tram-like-bus',
    type: 'cross',
    actors: [
      { from: 'S', to: 'left', kind: 'car', you: true, sign: 'yield' },
      { from: 'E', to: 'left', kind: 'car' },
    ],
    answer: 1,
    explain: 'התמרור מחייב אותך לתת זכות קדימה, וגם בלעדיו הרכב מגיע מימינך. הוא פונה ראשון.',
  },
];

function rotateScenario(scn, turns) {
  if (!turns) return scn;
  return {
    ...scn,
    missing: scn.missing ? rotateDir(scn.missing, turns) : undefined,
    actors: scn.actors.map((a) => ({
      ...a,
      from: a.from ? rotateDir(a.from, turns) : undefined,
      at: a.at ? rotateDir(a.at, turns) : undefined,
      ring: a.ring ? rotateDir(a.ring, turns) : undefined,
      exit: a.exit ? rotateDir(a.exit, turns) : undefined,
    })),
  };
}

/* ---------------------------------------------------------------- render */

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  kids.flat().forEach((k) => k && node.append(k));
  return node;
};

function roadBase(scn) {
  const g = svgEl('g');
  const arms = DIRS.filter((d) => d !== scn.missing);

  g.append(svgEl('rect', { x: 0, y: 0, width: 400, height: 400, fill: '#1a2233' }));

  // Each carriageway runs from the junction box out to whichever arms exist,
  // so a missing arm simply shortens the band to the junction edge.
  const top    = arms.includes('N') ? 0   : 150;
  const bottom = arms.includes('S') ? 400 : 250;
  const left   = arms.includes('W') ? 0   : 150;
  const right  = arms.includes('E') ? 400 : 250;

  g.append(svgEl('rect', { x: 150, y: top, width: 100, height: bottom - top, fill: '#333b4d' }));
  g.append(svgEl('rect', { x: left, y: 150, width: right - left, height: 100, fill: '#333b4d' }));

  // Lane divider on each arm.
  const dash = { stroke: '#f8fafc', 'stroke-width': 2.5, 'stroke-dasharray': '14 12', opacity: .55 };
  if (arms.includes('N')) g.append(svgEl('line', { x1: 200, y1: 0, x2: 200, y2: 150, ...dash }));
  if (arms.includes('S')) g.append(svgEl('line', { x1: 200, y1: 250, x2: 200, y2: 400, ...dash }));
  if (arms.includes('W')) g.append(svgEl('line', { x1: 0, y1: 200, x2: 150, y2: 200, ...dash }));
  if (arms.includes('E')) g.append(svgEl('line', { x1: 250, y1: 200, x2: 400, y2: 200, ...dash }));

  // Zebra crossings just outside the junction box.
  const zebra = (x, y, w, h, vert) => {
    const grp = svgEl('g');
    const n = 6;
    for (let i = 0; i < n; i++) {
      grp.append(svgEl('rect', {
        x: vert ? x : x + i * (w / n) + 1.5,
        y: vert ? y + i * (h / n) + 1.5 : y,
        width: vert ? w : w / n - 3,
        height: vert ? h / n - 3 : h,
        fill: '#e2e8f0', opacity: .8, rx: 1,
      }));
    }
    return grp;
  };
  if (arms.includes('S')) g.append(zebra(150, 256, 100, 14, false));
  if (arms.includes('N')) g.append(zebra(150, 130, 100, 14, false));
  if (arms.includes('W')) g.append(zebra(130, 150, 14, 100, true));
  if (arms.includes('E')) g.append(zebra(256, 150, 14, 100, true));

  return g;
}

function roundaboutBase() {
  const g = svgEl('g');
  g.append(svgEl('rect', { x: 0, y: 0, width: 400, height: 400, fill: '#1a2233' }));
  g.append(svgEl('rect', { x: 150, y: 0, width: 100, height: 400, fill: '#333b4d' }));
  g.append(svgEl('rect', { x: 0, y: 150, width: 400, height: 100, fill: '#333b4d' }));
  g.append(svgEl('circle', { cx: 200, cy: 200, r: 96, fill: '#333b4d' }));
  g.append(svgEl('circle', { cx: 200, cy: 200, r: 44, fill: '#2f7d4f', stroke: '#e2e8f0', 'stroke-width': 3 }));
  g.append(svgEl('circle', { cx: 200, cy: 200, r: 96, fill: 'none', stroke: '#e2e8f0', 'stroke-width': 2, 'stroke-dasharray': '10 8', opacity: .5 }));
  return g;
}

function signGlyph(kind, pos) {
  const g = svgEl('g', { transform: `translate(${pos.x},${pos.y})` });
  if (kind === 'stop') {
    const r = 15;
    const pts = Array.from({ length: 8 }, (_, i) => {
      const a = (Math.PI / 4) * i + Math.PI / 8;
      return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    g.append(svgEl('polygon', { points: pts, fill: '#dc2626', stroke: '#fff', 'stroke-width': 2 }));
    const label = svgEl('text', { y: 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 8.5, 'font-weight': 900 });
    label.append('עצור');
    g.append(label);
  } else if (kind === 'yield') {
    g.append(svgEl('polygon', { points: '0,14 -16,-13 16,-13', fill: '#fff', stroke: '#dc2626', 'stroke-width': 4 }));
  }
  return g;
}

function lightGlyph(state, pos) {
  const g = svgEl('g', { transform: `translate(${pos.x},${pos.y})` });
  g.append(svgEl('rect', { x: -8, y: -20, width: 16, height: 40, rx: 4, fill: '#0b0f16', stroke: '#475569', 'stroke-width': 1.5 }));
  const lamp = (cy, colour, on) => svgEl('circle', {
    cx: 0, cy, r: 4.6, fill: on ? colour : '#1e293b',
    ...(on ? { filter: 'url(#glow)' } : {}),
  });
  g.append(lamp(-11, '#ef4444', state === 'red'));
  g.append(lamp(0, '#f59e0b', state === 'amber' || state === 'flash'));
  g.append(lamp(11, '#22c55e', state === 'green'));
  if (state === 'flash') {
    const anim = svgEl('animate', { attributeName: 'opacity', values: '1;0.15;1', dur: '1s', repeatCount: 'indefinite' });
    g.children[2].append(anim);
  }
  return g;
}

function vehicleShape(kind, colour) {
  const g = svgEl('g');
  const body = (w, h, fill) => svgEl('rect', {
    class: 'actor-body', x: -w / 2, y: -h / 2, width: w, height: h, rx: 6,
    fill, stroke: '#0b0f16', 'stroke-width': 2,
  });
  const glass = (w, y, h) => svgEl('rect', { x: -w / 2, y, width: w, height: h, rx: 2, fill: '#cbd5e1', opacity: .85 });

  if (kind === 'truck') {
    g.append(body(30, 62, '#94a3b8'));
    g.append(svgEl('rect', { x: -15, y: -31, width: 30, height: 20, rx: 5, fill: colour, stroke: '#0b0f16', 'stroke-width': 2 }));
    g.append(glass(20, -28, 7));
  } else if (kind === 'bus') {
    g.append(body(30, 70, colour));
    g.append(glass(22, -32, 9));
    g.append(svgEl('rect', { x: -15, y: -6, width: 4, height: 16, fill: '#0b0f16', opacity: .5 }));
  } else if (kind === 'ambulance') {
    g.append(body(28, 56, '#f8fafc'));
    g.append(glass(20, -25, 8));
    g.append(svgEl('rect', { x: -3, y: -6, width: 6, height: 18, fill: '#dc2626' }));
    g.append(svgEl('rect', { x: -9, y: 0, width: 18, height: 6, fill: '#dc2626' }));
    const beacon = svgEl('circle', { cx: 0, cy: -30, r: 5, fill: '#3b82f6' });
    beacon.append(svgEl('animate', { attributeName: 'opacity', values: '1;0.2;1', dur: '.5s', repeatCount: 'indefinite' }));
    g.append(beacon);
  } else if (kind === 'moto') {
    g.append(body(14, 34, colour));
    g.append(svgEl('circle', { cx: 0, cy: -14, r: 4, fill: '#0b0f16' }));
  } else {
    g.append(body(26, 46, colour));
    g.append(glass(19, -18, 8));
    g.append(glass(19, 9, 7));
    g.append(svgEl('rect', { x: -11, y: -24, width: 5, height: 3, rx: 1, fill: '#fde68a' }));
    g.append(svgEl('rect', { x: 6, y: -24, width: 5, height: 3, rx: 1, fill: '#fde68a' }));
  }
  return g;
}

function pedestrianShape() {
  const g = svgEl('g');
  g.append(svgEl('circle', { class: 'actor-body', cx: 0, cy: -9, r: 6.5, fill: '#fbbf24', stroke: '#0b0f16', 'stroke-width': 2 }));
  g.append(svgEl('rect', { x: -5, y: -3, width: 10, height: 16, rx: 4, fill: '#fbbf24', stroke: '#0b0f16', 'stroke-width': 2 }));
  return g;
}

/** Point on the roundabout ring for a compass direction. */
function ringPoint(dir, radius = RING_R) {
  const a = (RING_ANGLE[dir] * Math.PI) / 180;
  return { x: 200 + radius * Math.cos(a), y: 200 + radius * Math.sin(a) };
}

/** Arc along the ring from `start` to `exit`, following RING_ORDER. */
function ringPath(start, exit) {
  const from = RING_ORDER.indexOf(start);
  const to = RING_ORDER.indexOf(exit);
  const steps = ((to - from) + 4) % 4 || 4;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const p = ringPoint(RING_ORDER[(from + i) % 4]);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
  }
  return d.trim();
}

function renderJunction(scn, onPick) {
  const svg = svgEl('svg', { viewBox: '0 0 400 400', role: 'img' });

  const defs = svgEl('defs');
  const glow = svgEl('filter', { id: 'glow' });
  glow.append(svgEl('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }));
  const merge = svgEl('feMerge');
  merge.append(svgEl('feMergeNode', { in: 'b' }), svgEl('feMergeNode', { in: 'SourceGraphic' }));
  glow.append(merge);
  const marker = svgEl('marker', {
    id: 'arrowhead', markerWidth: 6, markerHeight: 6, refX: 4.6, refY: 3, orient: 'auto',
  });
  marker.append(svgEl('path', { d: 'M0,0 L6,3 L0,6 z', fill: '#f8fafc' }));
  defs.append(glow, marker);
  svg.append(defs);

  svg.append(scn.type === 'roundabout' ? roundaboutBase() : roadBase(scn));

  // Intended paths first, so vehicles sit on top of their own arrow.
  scn.actors.forEach((a) => {
    if (a.kind === 'ped') return;
    let d = null;
    if (scn.type === 'roundabout') {
      if (a.ring) d = ringPath(a.ring, a.exit);
      else {
        const entry = ringPoint(a.from, RING_R);
        const start = APPROACH[a.from];
        d = `M${start.x},${start.y} L${entry.x.toFixed(1)},${entry.y.toFixed(1)}`;
      }
    } else {
      d = PATHS[a.from]?.[a.to];
    }
    if (d) {
      svg.append(svgEl('path', {
        d, fill: 'none', stroke: '#f8fafc', 'stroke-width': 2.5,
        'stroke-dasharray': '7 6', opacity: .55, 'marker-end': 'url(#arrowhead)',
      }));
    }
  });

  // Signs and lights.
  scn.actors.forEach((a) => {
    if (a.sign) svg.append(signGlyph(a.sign, SIGN_POS[a.from]));
    if (a.light) svg.append(lightGlyph(a.light, SIGN_POS[a.from]));
  });

  // Actors, each clickable.
  scn.actors.forEach((a, index) => {
    const group = svgEl('g', { class: 'actor', tabindex: 0, role: 'button' });
    group.dataset.index = String(index);

    if (a.kind === 'ped') {
      const zebra = {
        S: { x: 200, y: 263 }, N: { x: 200, y: 137 },
        W: { x: 137, y: 200 }, E: { x: 263, y: 200 },
      }[a.at];
      group.setAttribute('transform', `translate(${zebra.x},${zebra.y})`);
      group.append(pedestrianShape());
    } else if (a.ring) {
      const p = ringPoint(a.ring);
      const heading = { S: 90, E: 0, N: 270, W: 180 }[a.ring];
      group.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) rotate(${heading})`);
      group.append(vehicleShape(a.kind, ACTOR_COLOURS[index % ACTOR_COLOURS.length]));
    } else {
      const pos = APPROACH[a.from];
      group.setAttribute('transform', `translate(${pos.x},${pos.y}) rotate(${pos.rot})`);
      group.append(vehicleShape(a.kind, a.you ? '#22c55e' : ACTOR_COLOURS[index % ACTOR_COLOURS.length]));
    }

    // Counter-rotate the label so it stays upright whatever the heading.
    const rotation = /rotate\((-?\d+(?:\.\d+)?)\)/.exec(group.getAttribute('transform'))?.[1] ?? 0;
    const label = svgEl('g', { transform: `rotate(${-rotation})` });
    label.append(svgEl('circle', { cx: 0, cy: a.kind === 'ped' ? 22 : 0, r: 11, fill: '#0b0f16', opacity: .8 }));
    const text = svgEl('text', {
      y: (a.kind === 'ped' ? 22 : 0) + 4.5, 'text-anchor': 'middle',
      fill: '#fff', 'font-size': 13, 'font-weight': 900,
    });
    text.append(a.you ? 'א' : String(index + 1));
    label.append(text);
    group.append(label);

    if (a.you) {
      const tag = svgEl('g', { transform: `rotate(${-rotation}) translate(0, ${a.kind === 'ped' ? 40 : 34})` });
      const t = svgEl('text', { 'text-anchor': 'middle', fill: '#22c55e', 'font-size': 12, 'font-weight': 700 });
      t.append('אתה');
      tag.append(t);
      group.append(tag);
    }

    group.addEventListener('click', () => onPick(index, group));
    group.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(index, group); }
    });
    svg.append(group);
  });

  return svg;
}

/* ------------------------------------------------------------------ game */

const LEVELS = [
  { id: 'easy',   label: 'מתחיל',  desc: '8 צמתים · תמרורים ברורים', rounds: 8,  pool: ['right-rule', 'left-yields', 'stop-sign', 'yield-sign', 'lights-green', 'ambulance', 'pedestrian', 't-through'] },
  { id: 'normal', label: 'רגיל',   desc: '10 צמתים · כל הסוגים',     rounds: 10, pool: null },
  { id: 'hard',   label: 'מאתגר',  desc: '12 צמתים · כולל כיכרות',   rounds: 12, pool: null, timed: 14 },
];

export default {
  id: 'rightofway',
  title: 'מי נוסע ראשון',
  icon: '🔀',
  accent: 'var(--violet)',
  tagline: 'צמתים, כיכרות ותמרורי עצור — הנושא שהכי מפילים בו.',

  mount(root, api) {
    let disposed = false;
    let stopTimer = () => {};

    showSetup();

    function showSetup() {
      stopTimer();
      const levels = levelPicker(LEVELS, 'normal');
      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '🔀 מי נוסע ראשון' }),
          el('p', { text: 'הרכב הירוק המסומן "אתה". לחצ/י על הרכב או הולך הרגל שזכאי לעבור ראשון.' })),
        el('div', { class: 'card stack' }, el('h3', { text: 'רמת קושי' }), levels,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל',
            onClick: () => play(LEVELS.find((l) => l.id === levels.value)),
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function buildDeck(level) {
      const source = level.pool ? SCENARIOS.filter((s) => level.pool.includes(s.id)) : SCENARIOS;
      const deck = [];
      while (deck.length < level.rounds) {
        shuffle(source).forEach((s) => {
          if (deck.length < level.rounds) deck.push(rotateScenario(s, randInt(0, 3)));
        });
      }
      return deck;
    }

    function play(level) {
      stopTimer();
      const deck = buildDeck(level);

      let index = 0;
      let score = 0;
      let correct = 0;
      let streak = 0;
      let bestStreak = 0;
      let answered = false;
      let askedAt = 0;
      let countdown = null;

      const scoreHud = hudItem('ניקוד', 0);
      const streakHud = hudItem('רצף', 0, 'good');
      const progressHud = hudItem('צומת', `1/${level.rounds}`);
      const timeHud = level.timed ? hudItem('זמן', level.timed, 'warn') : null;

      const stage = el('div', { class: 'junction-wrap' });
      const prompt = el('h3', { text: 'מי עובר ראשון?' });
      const feedback = el('div', { class: 'feedback', style: { display: 'none' } },
        el('strong'), el('span'));
      const nextBtn = el('button', {
        class: 'btn btn-primary btn-lg btn-block', text: 'הצומת הבא', style: { display: 'none' },
        onClick: () => { index += 1; render(); },
      });

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, scoreHud, streakHud, progressHud, timeHud),
        el('div', { class: 'card stack' }, prompt, stage, feedback, nextBtn),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stopTimer(); showSetup(); } }),
      ));

      render();

      function render() {
        stopTimer();
        stopTimer = () => {};
        if (disposed) return;
        if (index >= deck.length) return finish();

        const scn = deck[index];
        answered = false;
        askedAt = performance.now();
        progressHud.setValue(`${index + 1}/${level.rounds}`);
        feedback.style.display = 'none';
        nextBtn.style.display = 'none';

        clear(stage).append(renderJunction(scn, (picked, node) => choose(scn, picked, node)));

        if (level.timed) {
          let left = level.timed;
          timeHud.setValue(left, 'warn');
          countdown = setInterval(() => {
            left -= 1;
            timeHud.setValue(Math.max(0, left), left <= 4 ? 'bad' : 'warn');
            if (left <= 0) { clearInterval(countdown); choose(scn, -1, null); }
          }, 1000);
          stopTimer = () => clearInterval(countdown);
        }
      }

      function choose(scn, picked, node) {
        if (answered) return;
        answered = true;
        stopTimer();

        const seconds = (performance.now() - askedAt) / 1000;
        const isCorrect = picked === scn.answer;
        const nodes = [...stage.querySelectorAll('.actor')];
        nodes.forEach((n) => n.classList.add('locked'));

        if (isCorrect) {
          correct += 1;
          streak += 1;
          bestStreak = Math.max(bestStreak, streak);
          const speed = Math.max(0, Math.round(60 - seconds * 6));
          const multiplier = Math.min(3, 1 + Math.floor(streak / 4) * 0.5);
          score += Math.round((120 + speed) * multiplier);
          node?.classList.add('picked-right');
          scoreHud.setValue(score);
          streakHud.setValue(streak);
        } else {
          streak = 0;
          streakHud.setValue(0);
          node?.classList.add('picked-wrong');
          nodes[scn.answer]?.classList.add('reveal');
        }

        Store.logAnswer('rightofway', isCorrect);

        const who = scn.actors[scn.answer];
        const name = who.you ? 'אתה' : who.kind === 'ped' ? 'הולך הרגל' : `רכב ${scn.answer + 1}`;
        feedback.className = `feedback ${isCorrect ? 'good' : 'bad'}`;
        feedback.style.display = '';
        feedback.firstChild.textContent = picked === -1
          ? `⏱️ נגמר הזמן — עובר ראשון: ${name}`
          : `${isCorrect ? '✅ נכון' : '❌ לא נכון'} — עובר ראשון: ${name}`;
        feedback.lastChild.textContent = scn.explain;
        nextBtn.style.display = '';
        nextBtn.textContent = index + 1 >= deck.length ? 'לסיכום' : 'הצומת הבא';
        nextBtn.focus();
      }

      function finish() {
        stopTimer();
        const accuracy = Math.round((correct / deck.length) * 100);
        if (bestStreak >= 10) Store.award('priority');

        const outcome = Store.finishRun('rightofway', {
          score, xp: Math.round(score / 10), label: level.label,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        clear(root).append(resultScreen({
          title: accuracy >= 80 ? 'שליטה בצמתים' : 'יש מה לחזק',
          emoji: accuracy >= 80 ? '🏆' : accuracy >= 60 ? '🙂' : '📚',
          score,
          passed: accuracy >= 70,
          stats: [['דיוק', `${accuracy}%`], ['נכונות', `${correct}/${deck.length}`], ['רצף שיא', bestStreak]],
          outcome,
          onReplay: () => play(level),
          onHome: api.home,
        }));
      }
    }

    return () => { disposed = true; stopTimer(); };
  },
};
