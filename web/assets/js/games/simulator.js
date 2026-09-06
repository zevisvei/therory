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

import { el, clear, pick, shuffle, clamp, fitCanvas, loop, resultScreen, levelPicker, chipGroup, toast } from '../ui.js';
import { Store } from '../store.js';

const VIEW_W = 880;
const VIEW_H = 520;
const ZOOM = 0.78;

const BLOCK = 460;
const ROAD_W = 104;
const HALF_ROAD = ROAD_W / 2;
const LANE_OFFSET = ROAD_W / 4;
const STUB = 150;              // length of the decorative cross streets

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

  return { nodes: nodes.map(pos), segments, junctions };
}

/** Traffic-light state for the player's approach at time `t`. */
function lightState(junction, t) {
  const cycle = 20;
  const phase = (t + junction.phase) % cycle;
  if (phase < 9) return 'green';
  if (phase < 11.5) return 'amber';
  return 'red';
}

/* ------------------------------------------------------------------ game */

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
          el('div', { class: 'divider' }),
          el('div', { class: 'small muted' },
            el('p', { text: 'מקלדת: ↑ גז · ↓ בלם · ← → היגוי · Z איתות שמאלה · X איתות ימינה' }),
            el('p', { text: 'בנייד: לחצני המסך שמתחת ללוח.' })),
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל מבחן',
            onClick: () => {
              const chosen = topics.value.length ? topics.value : ['lights'];
              const level = LEVELS.find((l) => l.id === levels.value);
              Store.setExtra('simulator', { topics: chosen, level: level.id });
              play(level, chosen);
            },
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(level, topics) {
      stop();

      const route = buildRoute(level, topics);
      const start = route.segments[0];

      const car = {
        x: start.a.x + start.right.x * LANE_OFFSET,
        y: start.a.y + start.right.y * LANE_OFFSET,
        heading: Math.atan2(start.dir.y, start.dir.x),
        speed: 0,
      };

      const input = { gas: false, brake: false, left: false, right: false };
      let signal = null;              // 'left' | 'right' | null
      let elapsed = 0;
      let nextJunction = 0;
      let finished = false;

      const faults = [];
      let minors = 0;
      let criticalFault = null;

      // Timers for the "sustained" rules.
      let overSpeedFor = 0;
      let offRoadFor = 0;
      let wrongLaneFor = 0;
      let crawlFor = 0;

      const others = topics.includes('traffic') ? spawnTraffic(route) : [];

      /* ---------------------------------------------------------- layout */
      const canvas = el('canvas');
      const ctx = fitCanvas(canvas, VIEW_W, VIEW_H);

      const speedGauge = el('div', { class: 'gauge' }, el('b', { text: '0' }), el('span', { text: 'קמ״ש' }));
      const limitGauge = el('div', { class: 'gauge' }, el('b', { text: '50' }), el('span', { text: 'מותר' }));
      const instruction = el('div', { class: 'sim-instruction', text: 'צא/י לדרך' });
      const overlay = el('div', { class: 'canvas-overlay' },
        el('div', { class: 'stack center' },
          el('h2', { text: 'מוכן/ה?' }),
          el('p', { class: 'muted', text: 'הבוחן מתחיל למדוד ברגע שתלחצ/י.' }),
          el('button', { class: 'btn btn-green btn-lg', text: 'התחל נסיעה', onClick: begin })));

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

      const touch = el('div', { class: 'touch-pad' },
        touchBtn('Z', () => setSignal('left'), null, '◀'),
        touchBtn('left', null, 'left', '⟲'),
        touchBtn('gas', null, 'gas', '▲'),
        touchBtn('brake', null, 'brake', '▼'),
        touchBtn('right', null, 'right', '⟳'),
        touchBtn('X', () => setSignal('right'), null, '▶'));

      const panel = el('div', { class: 'card stack' },
        el('div', { class: 'spread' }, el('h3', { text: 'דוח הבוחן' }),
          el('span', { class: 'small muted' }, 'ליקויים: ', minorsLine)),
        el('div', { class: 'spread' }, el('span', { class: 'small muted', text: 'איתות' }), signalLamps),
        el('div', { class: 'divider' }),
        faultLog);

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'sim-layout' }, el('div', { class: 'stack' }, wrap, touch), panel),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stop(); showSetup(); } }),
      ));

      function touchBtn(id, onPress, holdKey, glyph) {
        const b = el('button', { type: 'button', text: glyph });
        const down = (e) => {
          e.preventDefault();
          b.classList.add('active');
          if (holdKey) input[holdKey] = true;
          if (onPress) onPress();
        };
        const up = (e) => {
          e.preventDefault();
          b.classList.remove('active');
          if (holdKey) input[holdKey] = false;
        };
        b.addEventListener('pointerdown', down);
        b.addEventListener('pointerup', up);
        b.addEventListener('pointerleave', up);
        b.addEventListener('pointercancel', up);
        return b;
      }

      /* ----------------------------------------------------------- input */
      function onKeyDown(e) {
        switch (e.key) {
          case 'ArrowUp': case 'w': case 'W': input.gas = true; break;
          case 'ArrowDown': case 's': case 'S': input.brake = true; break;
          case 'ArrowLeft': case 'a': case 'A': input.left = true; break;
          case 'ArrowRight': case 'd': case 'D': input.right = true; break;
          case 'z': case 'Z': setSignal('left'); return;
          case 'x': case 'X': setSignal('right'); return;
          default: return;
        }
        e.preventDefault();
      }
      function onKeyUp(e) {
        switch (e.key) {
          case 'ArrowUp': case 'w': case 'W': input.gas = false; break;
          case 'ArrowDown': case 's': case 'S': input.brake = false; break;
          case 'ArrowLeft': case 'a': case 'A': input.left = false; break;
          case 'ArrowRight': case 'd': case 'D': input.right = false; break;
          default: return;
        }
        e.preventDefault();
      }

      function setSignal(side) {
        signal = signal === side ? null : side;
        signalLamps.children[0].classList.toggle('on', signal === 'left');
        signalLamps.children[1].classList.toggle('on', signal === 'right');
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
          criticalFault = entry;
          endRun(false);
        } else {
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
      let running = false;

      function begin() {
        overlay.style.display = 'none';
        running = true;
        canvas.focus();
      }

      function step(dt) {
        if (disposed) return;
        if (!running || finished) { draw(); return; }

        elapsed += dt;

        // Longitudinal.
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

        updateTraffic(dt);
        checkRules(dt);
        draw();
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
        speedGauge.classList.toggle('over', seg && kmh > seg.limit + level.speedGrace);

        // --- speed limit
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

        // --- staying on the carriageway
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

        // --- lane discipline (skipped inside junction boxes, where crossing is normal)
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

        // --- obstructing traffic
        if (!level.lenient && seg && kmh < 8 && onRoad() && !nearAnyStopRequirement()) {
          crawlFor += dt;
          if (crawlFor > 7) {
            crawlFor = 0;
            addFault('minor', 'נסיעה איטית מדי', 'נסיעה איטית ללא סיבה מפריעה לתנועה ומהווה ליקוי.');
          }
        } else {
          crawlFor = 0;
        }

        // --- junctions
        const junction = route.junctions[nextJunction];
        if (junction) handleJunction(junction, dt, kmh);

        // --- collisions
        for (const other of others) {
          if (Math.hypot(other.x - car.x, other.y - car.y) < 34) {
            addFault('critical', 'תאונה — פגיעה ברכב אחר', 'מגע עם רכב אחר הוא כישלון מיידי במבחן.');
            return;
          }
        }

        // --- finish line
        const last = route.nodes[route.nodes.length - 1];
        if (Math.hypot(car.x - last.x, car.y - last.y) < 70) {
          endRun(true);
        }
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

        // Pedestrian steps out when the player gets close.
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

        // Signalling has to be on before reaching the line, not after.
        if (topics.includes('signals') && j.turn !== 'straight' && !j.signalChecked && gap < 140 && gap > 20) {
          if (signal === j.turn) j.signalChecked = 'ok';
        }

        if (gap > 0) return;          // not across the line yet
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

        setSignalOffAfterTurn();
        nextJunction += 1;
      }

      function setSignalOffAfterTurn() {
        if (signal) setSignal(signal);
      }

      /* ------------------------------------------------------- other cars */
      function spawnTraffic(rt) {
        const cars = [];
        rt.segments.forEach((seg, i) => {
          if (i === 0 || Math.random() > 0.7) return;
          const t = 0.35 + Math.random() * 0.4;
          cars.push({
            x: seg.a.x + (seg.b.x - seg.a.x) * t - seg.right.x * LANE_OFFSET,
            y: seg.a.y + (seg.b.y - seg.a.y) * t - seg.right.y * LANE_OFFSET,
            vx: -seg.dir.x, vy: -seg.dir.y,
            speed: 70 + Math.random() * 50,
            colour: pick(['#64748b', '#a855f7', '#0ea5e9', '#f97316']),
            seg,
          });
        });
        return cars;
      }

      function updateTraffic(dt) {
        for (const o of others) {
          o.x += o.vx * o.speed * dt;
          o.y += o.vy * o.speed * dt;
          // Recycle a car once it has driven well past the start of its segment.
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

        ctx.translate(VIEW_W / 2, VIEW_H / 2);
        ctx.scale(ZOOM, ZOOM);
        ctx.translate(-car.x - Math.cos(car.heading) * 90, -car.y - Math.sin(car.heading) * 90);

        // Cross-street stubs, so junctions read as junctions.
        ctx.fillStyle = '#2b3242';
        for (const node of route.nodes) {
          ctx.fillRect(node.x - HALF_ROAD - STUB, node.y - HALF_ROAD, ROAD_W + STUB * 2, ROAD_W);
          ctx.fillRect(node.x - HALF_ROAD, node.y - HALF_ROAD - STUB, ROAD_W, ROAD_W + STUB * 2);
        }

        // Route carriageway.
        ctx.fillStyle = '#3a4152';
        for (const seg of route.segments) {
          const x = Math.min(seg.a.x, seg.b.x) - HALF_ROAD;
          const y = Math.min(seg.a.y, seg.b.y) - HALF_ROAD;
          const w = Math.abs(seg.b.x - seg.a.x) + ROAD_W;
          const h = Math.abs(seg.b.y - seg.a.y) + ROAD_W;
          ctx.fillRect(x, y, w, h);
        }

        // Centre lines.
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

        // Junction furniture.
        route.junctions.forEach((j, i) => {
          const d = j.incoming.dir;
          const sx = j.centre.x - d.x * HALF_ROAD;
          const sy = j.centre.y - d.y * HALF_ROAD;

          // stop line
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(sx - j.incoming.right.x * HALF_ROAD, sy - j.incoming.right.y * HALF_ROAD);
          ctx.lineTo(sx, sy);
          ctx.stroke();

          // zebra
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
              ctx.fillStyle = on ? colour : '#1e293b';
              ctx.beginPath();
              ctx.arc(signX, signY + dy, 6, 0, Math.PI * 2);
              ctx.fill();
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

          // Speed-limit plate at the start of each leg.
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

          // Pedestrian on the crossing.
          if (j.pedestrian?.active) {
            const t = clamp(j.pedestrian.t, 0, 1.6) / 1.6;
            const px = sx - d.x * 26 + j.incoming.right.x * (HALF_ROAD - t * ROAD_W * 1.15);
            const py = sy - d.y * 26 + j.incoming.right.y * (HALF_ROAD - t * ROAD_W * 1.15);
            ctx.fillStyle = '#fbbf24';
            ctx.beginPath(); ctx.arc(px, py - 7, 6, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.roundRect(px - 5, py - 1, 10, 15, 4); ctx.fill();
          }

          // Guidance arrow on the junction the player is heading for.
          if (i === nextJunction) {
            ctx.save();
            ctx.globalAlpha = 0.55 + Math.sin(elapsed * 4) * 0.2;
            ctx.fillStyle = '#3b82f6';
            ctx.beginPath();
            ctx.arc(j.centre.x, j.centre.y, 30, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        });

        // Finish marker.
        const last = route.nodes[route.nodes.length - 1];
        ctx.fillStyle = '#22c55e';
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 46, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e8edf5';
        ctx.font = 'bold 18px Rubik, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('סיום', last.x, last.y + 6);

        // Other traffic.
        for (const o of others) drawCar(o.x, o.y, Math.atan2(o.vy, o.vx), o.colour, false);

        // Player.
        drawCar(car.x, car.y, car.heading, '#22c55e', true);

        ctx.restore();

        updateInstruction();
      }

      function drawCar(x, y, heading, colour, isPlayer) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(heading);
        ctx.fillStyle = 'rgba(0,0,0,.4)';
        ctx.beginPath(); ctx.roundRect(-CAR_L / 2 + 3, -CAR_W / 2 + 3, CAR_L, CAR_W, 6); ctx.fill();
        ctx.fillStyle = colour;
        ctx.beginPath(); ctx.roundRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W, 6); ctx.fill();
        ctx.fillStyle = 'rgba(203,213,225,.9)';
        ctx.beginPath(); ctx.roundRect(2, -CAR_W / 2 + 3, 12, CAR_W - 6, 3); ctx.fill();

        if (isPlayer) {
          ctx.fillStyle = '#fde68a';
          ctx.fillRect(CAR_L / 2 - 3, -CAR_W / 2 + 2, 3, 5);
          ctx.fillRect(CAR_L / 2 - 3, CAR_W / 2 - 7, 3, 5);
          if (signal) {
            const blink = Math.floor(elapsed * 3) % 2 === 0;
            if (blink) {
              ctx.fillStyle = '#f59e0b';
              const sy = signal === 'left' ? -CAR_W / 2 : CAR_W / 2 - 5;
              ctx.fillRect(-CAR_L / 2, sy, 8, 5);
              ctx.fillRect(CAR_L / 2 - 8, sy, 8, 5);
            }
          }
        }
        ctx.restore();
      }

      function updateInstruction() {
        const j = route.junctions[nextJunction];
        if (!j) {
          const last = route.nodes[route.nodes.length - 1];
          const d = Math.round(Math.hypot(car.x - last.x, car.y - last.y) / 10);
          instruction.textContent = `סיום המסלול · ${d} מ׳`;
          return;
        }
        const metres = Math.max(0, Math.round(distanceToStopLine(j) / 10));
        const control = j.control === 'light' ? ' · רמזור'
          : j.control === 'stop' ? ' · תמרור עצור'
          : j.control === 'yield' ? ' · תן זכות קדימה' : '';
        instruction.textContent = `${TURN_TEXT[j.turn]} בעוד ${metres} מ׳${control}`;
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
