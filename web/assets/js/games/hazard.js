/**
 * Hazard perception — a top-down drive where the player taps a developing
 * hazard as early as they can spot it.
 *
 * Scoring rewards early recognition rather than reaction speed alone: the
 * window opens the moment a hazard starts developing and the points decay
 * across it, so a late-but-correct tap still scores something and a random tap
 * costs you.
 */

import { el, clear, shuffle, randInt, clamp, hudItem, fitCanvas, pointerPos, loop, resultScreen, levelPicker, toast } from '../ui.js';
import { Store } from '../store.js';

const W = 720;
const H = 480;
const ROAD_L = 190;
const ROAD_R = 530;
const CENTRE = 360;
const CAR_X = 445;
const CAR_SCREEN_Y = H - 110;

const LEVELS = [
  { id: 'easy',   label: 'מתחיל', desc: '6 סיכונים · 3 שניות',   count: 6,  window: 3.0, speed: 115 },
  { id: 'normal', label: 'רגיל',  desc: '8 סיכונים · 2.4 שניות', count: 8,  window: 2.4, speed: 150 },
  { id: 'hard',   label: 'עירוני צפוף', desc: '10 סיכונים · 1.8 שניות', count: 10, window: 1.8, speed: 200 },
];

const HAZARDS = [
  {
    id: 'child', label: 'ילד/ה בין מכוניות חונות',
    tip: 'בין רכבים חונים לא רואים ילדים. במקום כזה מאטים תמיד — גם כשלא רואים אף אחד.',
    build: (worldY) => ({ kind: 'ped', x: 486, y: worldY, vx: -70, w: 16, h: 16, colour: '#fbbf24' }),
  },
  {
    id: 'door', label: 'דלת נפתחת מרכב חונה',
    tip: 'שמור מרווח של לפחות מטר מרכבים חונים — דלת נפתחת ללא אזהרה.',
    build: (worldY) => ({ kind: 'door', x: 486, y: worldY, vx: 0, w: 30, h: 8, colour: '#e2e8f0', grow: 34 }),
  },
  {
    id: 'pullout', label: 'רכב יוצא מחניה',
    tip: 'רכב חונה עם גלגלים מופנים החוצה או אורות דולקים עומד להשתלב. האט והיה מוכן.',
    build: (worldY) => ({ kind: 'car', x: 500, y: worldY, vx: -55, w: 38, h: 66, colour: '#a855f7' }),
  },
  {
    id: 'cyclist', label: 'רוכב אופניים סוטה מנתיבו',
    tip: 'רוכבי אופניים סוטים כדי לעקוף בור או מכסה ביוב. עקוף במרווח של מטר וחצי לפחות.',
    build: (worldY) => ({ kind: 'bike', x: 512, y: worldY, vx: -40, w: 14, h: 30, colour: '#22d3ee' }),
  },
  {
    id: 'crossing', label: 'הולך רגל נכנס למעבר חצייה',
    tip: 'לפני מעבר חצייה מאטים ובודקים את המדרכות משני הצדדים, לא רק את המעבר עצמו.',
    build: (worldY) => ({ kind: 'ped', x: 175, y: worldY, vx: 78, w: 16, h: 16, colour: '#f472b6', crossing: true }),
  },
  {
    id: 'ball', label: 'כדור מתגלגל לכביש',
    tip: 'אחרי כדור מגיע ילד. כדור שמתגלגל לכביש הוא סימן לעצור, לא רק להאט.',
    build: (worldY) => ({ kind: 'ball', x: 500, y: worldY, vx: -120, w: 14, h: 14, colour: '#fb923c' }),
  },
  {
    id: 'brake', label: 'הרכב שלפניך בולם בחוזקה',
    tip: 'שמור מרחק של שתי שניות לפחות מהרכב שלפניך — בכביש רטוב, ארבע.',
    build: (worldY) => ({ kind: 'braking', x: CAR_X, y: worldY, vx: 0, w: 40, h: 68, colour: '#64748b' }),
  },
  {
    id: 'sidestreet', label: 'רכב יוצא מדרך צדדית',
    tip: 'בדרך צדדית מימין הרכב חייב לתת לך זכות קדימה — אבל לא תמיד הוא עושה זאת.',
    build: (worldY) => ({ kind: 'car', x: 585, y: worldY, vx: -95, w: 38, h: 62, colour: '#ef4444' }),
  },
];

export default {
  id: 'hazard',
  title: 'איתור סיכונים',
  icon: '👁️',
  accent: 'var(--green)',
  tagline: 'סרוק את הכביש ולחץ על הסיכון ברגע שהוא מתפתח.',

  mount(root, api) {
    let disposed = false;
    let stop = () => {};

    showSetup();

    function showSetup() {
      stop();
      const levels = levelPicker(LEVELS, 'normal');
      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '👁️ איתור סיכונים' }),
          el('p', { text: 'אתה נוהג. ברגע שמשהו מתחיל להתפתח לסיכון — לחצ/י עליו. ככל שמוקדם יותר, כך יותר נקודות. לחיצה על לא-סיכון עולה בנקודות.' })),
        el('div', { class: 'card stack' }, el('h3', { text: 'רמת קושי' }), levels,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל נסיעה',
            onClick: () => play(LEVELS.find((l) => l.id === levels.value)),
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(level) {
      stop();

      const canvas = el('canvas');
      const wrap = el('div', { class: 'canvas-wrap' }, canvas);
      const ctx = fitCanvas(canvas, W, H);

      const scoreHud = hudItem('ניקוד', 0);
      const spottedHud = hudItem('אותרו', `0/${level.count}`);
      const missHud = hudItem('פספוסים', 0, 'bad');
      const banner = el('div', { class: 'feedback', style: { display: 'none' } }, el('strong'), el('span'));

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, scoreHud, spottedHud, missHud),
        wrap,
        banner,
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stop(); showSetup(); } }),
      ));

      // ---- world state
      let carY = 0;                 // distance travelled, in world units
      let score = 0;
      let spotted = 0;
      let missed = 0;
      let falseAlarms = 0;
      let bestReaction = Infinity;
      const reactions = [];

      const scenery = buildScenery();
      const schedule = buildSchedule(level);
      let active = null;            // the hazard currently developing
      let flash = 0;                // screen tint after a tap, seconds remaining
      let flashGood = false;

      function buildScenery() {
        const items = [];
        for (let y = 0; y < 400 * level.count + 1200; y += 90) {
          if (Math.random() < 0.55) {
            items.push({ type: 'parked', x: 500, y, colour: ['#475569', '#334155', '#5b6b85'][randInt(0, 2)] });
          }
          if (Math.random() < 0.4) items.push({ type: 'tree', x: 120 + Math.random() * 40, y });
          if (Math.random() < 0.4) items.push({ type: 'tree', x: 585 + Math.random() * 40, y });
          if (Math.random() < 0.25) items.push({ type: 'building', x: Math.random() < 0.5 ? 20 : 620, y, h: 60 + Math.random() * 90 });
        }
        return items;
      }

      function buildSchedule(lvl) {
        const kinds = [];
        while (kinds.length < lvl.count) kinds.push(...shuffle(HAZARDS));
        return kinds.slice(0, lvl.count).map((spec, i) => ({
          spec,
          triggerAt: 520 + i * (520 + randInt(0, 220)),
          fired: false,
          resolved: false,
        }));
      }

      const worldToScreenY = (worldY) => CAR_SCREEN_Y - (worldY - carY);

      function activate(entry) {
        entry.fired = true;
        const ent = entry.spec.build(entry.triggerAt + 300);
        active = {
          entry,
          ent,
          openedAt: performance.now(),
          extend: 0,
        };
      }

      function resolveActive(hit, reactionSeconds) {
        if (!active) return;
        active.entry.resolved = true;

        if (hit) {
          spotted += 1;
          const earliness = clamp(1 - reactionSeconds / level.window, 0, 1);
          const points = Math.round(80 + 320 * earliness);
          score += points;
          reactions.push(reactionSeconds);
          bestReaction = Math.min(bestReaction, reactionSeconds);
          flashGood = true;
          showBanner(true, `+${points} · ${active.entry.spec.label}`, active.entry.spec.tip);
        } else {
          missed += 1;
          flashGood = false;
          showBanner(false, `פספוס: ${active.entry.spec.label}`, active.entry.spec.tip);
        }

        flash = 0.35;
        scoreHud.setValue(score);
        spottedHud.setValue(`${spotted}/${level.count}`);
        missHud.setValue(missed);
        active = null;
      }

      function showBanner(good, title, tip) {
        banner.className = `feedback ${good ? 'good' : 'bad'}`;
        banner.style.display = '';
        banner.firstChild.textContent = title;
        banner.lastChild.textContent = tip;
      }

      function onTap(event) {
        if (disposed) return;
        const p = pointerPos(canvas, event, W, H);

        if (active) {
          const e = active.ent;
          const sy = worldToScreenY(e.y);
          const pad = 26;
          const inside = p.x >= e.x - e.w / 2 - pad && p.x <= e.x + e.w / 2 + pad
                      && p.y >= sy - e.h / 2 - pad && p.y <= sy + e.h / 2 + pad;
          if (inside) {
            resolveActive(true, (performance.now() - active.openedAt) / 1000);
            return;
          }
        }

        falseAlarms += 1;
        score = Math.max(0, score - 75);
        scoreHud.setValue(score);
        flash = 0.25;
        flashGood = false;
        showBanner(false, 'התראת שווא (−75)', 'לחיצה על מה שאינו סיכון. סרוק את התמונה — אל תלחץ על כל תנועה.');
      }

      canvas.addEventListener('pointerdown', onTap);

      const cancelLoop = loop((dt) => {
        if (disposed) return;
        carY += level.speed * dt;

        // Fire the next scheduled hazard.
        const pending = schedule.find((s) => !s.fired);
        if (pending && carY >= pending.triggerAt) activate(pending);

        // Advance and time out the live hazard.
        if (active) {
          const e = active.ent;
          e.x += e.vx * dt;
          if (e.kind === 'door') e.w = Math.min(e.grow, e.w + 40 * dt);
          if (e.kind === 'braking') e.y -= 40 * dt;
          const openFor = (performance.now() - active.openedAt) / 1000;
          if (openFor > level.window) resolveActive(false, openFor);
        }

        if (flash > 0) flash -= dt;

        const done = schedule.every((s) => s.resolved);
        if (done) { cancelLoop(); finish(); return; }

        draw();
      });

      stop = () => {
        cancelLoop();
        canvas.removeEventListener('pointerdown', onTap);
      };

      /* ------------------------------------------------------------ draw */
      function draw() {
        ctx.fillStyle = '#16281b';
        ctx.fillRect(0, 0, W, H);

        // Road surface and kerbs.
        ctx.fillStyle = '#3a4152';
        ctx.fillRect(ROAD_L, 0, ROAD_R - ROAD_L, H);
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(ROAD_L - 22, 0, 22, H);
        ctx.fillRect(ROAD_R, 0, 22, H);

        // A right-hand side street, drawn where the sidestreet hazard emerges.
        const streetWorld = Math.floor((carY + 400) / 900) * 900;
        const streetY = worldToScreenY(streetWorld);
        if (streetY > -140 && streetY < H + 140) {
          ctx.fillStyle = '#3a4152';
          ctx.fillRect(ROAD_R, streetY - 55, W - ROAD_R, 110);
        }

        // Lane markings scroll with the world.
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 3;
        ctx.setLineDash([26, 22]);
        ctx.lineDashOffset = (carY % 48);
        ctx.beginPath();
        ctx.moveTo(CENTRE, -20);
        ctx.lineTo(CENTRE, H + 20);
        ctx.stroke();
        ctx.setLineDash([]);

        // Scenery.
        for (const item of scenery) {
          const sy = worldToScreenY(item.y);
          if (sy < -160 || sy > H + 160) continue;
          if (item.type === 'parked') drawCar(item.x, sy, 38, 64, item.colour, false);
          else if (item.type === 'tree') {
            ctx.fillStyle = '#166534';
            ctx.beginPath(); ctx.arc(item.x, sy, 17, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#14532d';
            ctx.beginPath(); ctx.arc(item.x - 4, sy - 4, 11, 0, Math.PI * 2); ctx.fill();
          } else if (item.type === 'building') {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(item.x, sy - item.h / 2, 80, item.h);
            ctx.fillStyle = '#334155';
            ctx.fillRect(item.x + 6, sy - item.h / 2 + 6, 68, item.h - 12);
          }
        }

        // Crosswalk near a pedestrian-crossing hazard.
        if (active?.entry.spec.id === 'crossing') {
          const sy = worldToScreenY(active.ent.y);
          ctx.fillStyle = '#e2e8f0';
          for (let i = 0; i < 8; i++) {
            ctx.fillRect(ROAD_L + 6 + i * 42, sy - 26, 26, 52);
          }
        }

        // The live hazard.
        if (active) {
          const e = active.ent;
          const sy = worldToScreenY(e.y);
          if (e.kind === 'ped') drawPed(e.x, sy, e.colour);
          else if (e.kind === 'ball') {
            ctx.fillStyle = e.colour;
            ctx.beginPath(); ctx.arc(e.x, sy, 7, 0, Math.PI * 2); ctx.fill();
          } else if (e.kind === 'bike') {
            ctx.fillStyle = e.colour;
            ctx.fillRect(e.x - 7, sy - 15, 14, 30);
            drawPed(e.x, sy - 4, '#e2e8f0', 0.8);
          } else if (e.kind === 'door') {
            drawCar(500, sy, 38, 64, '#475569', false);
            ctx.fillStyle = e.colour;
            ctx.fillRect(500 - 19 - e.w, sy - 14, e.w, 9);
          } else if (e.kind === 'braking') {
            drawCar(e.x, sy, e.w, e.h, e.colour, false);
            ctx.fillStyle = '#ef4444';
            ctx.shadowColor = '#ef4444';
            ctx.shadowBlur = 16;
            ctx.fillRect(e.x - e.w / 2 + 4, sy + e.h / 2 - 8, 10, 6);
            ctx.fillRect(e.x + e.w / 2 - 14, sy + e.h / 2 - 8, 10, 6);
            ctx.shadowBlur = 0;
          } else {
            drawCar(e.x, sy, e.w, e.h, e.colour, false);
          }
        }

        // Player car.
        drawCar(CAR_X, CAR_SCREEN_Y, 40, 70, '#22c55e', true);

        // Tap feedback tint.
        if (flash > 0) {
          ctx.fillStyle = flashGood ? `rgba(34,197,94,${flash * 0.5})` : `rgba(239,68,68,${flash * 0.5})`;
          ctx.fillRect(0, 0, W, H);
        }

        // Countdown ring while a hazard is live.
        if (active) {
          const left = 1 - (performance.now() - active.openedAt) / 1000 / level.window;
          ctx.strokeStyle = left > 0.4 ? '#22c55e' : '#f59e0b';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.arc(52, 52, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(left, 0, 1));
          ctx.stroke();
        }
      }

      function drawCar(x, y, w, h, colour, isPlayer) {
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,.35)';
        ctx.beginPath();
        ctx.roundRect(x - w / 2 + 3, y - h / 2 + 4, w, h, 8);
        ctx.fill();

        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 8);
        ctx.fill();

        ctx.fillStyle = 'rgba(203,213,225,.85)';
        ctx.beginPath();
        ctx.roundRect(x - w / 2 + 5, y - h / 2 + 8, w - 10, h * 0.22, 3);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x - w / 2 + 5, y + h / 2 - 8 - h * 0.2, w - 10, h * 0.2, 3);
        ctx.fill();

        if (isPlayer) {
          ctx.fillStyle = '#fde68a';
          ctx.fillRect(x - w / 2 + 4, y - h / 2 - 2, 8, 4);
          ctx.fillRect(x + w / 2 - 12, y - h / 2 - 2, 8, 4);
        }
        ctx.restore();
      }

      function drawPed(x, y, colour, scale = 1) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.arc(x, y - 8 * scale, 6 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.roundRect(x - 5 * scale, y - 2 * scale, 10 * scale, 15 * scale, 4 * scale);
        ctx.fill();
      }

      function finish() {
        stop();
        const avg = reactions.length ? reactions.reduce((a, b) => a + b, 0) / reactions.length : 0;
        if (score >= 1200) Store.award('hawk');

        const outcome = Store.finishRun('hazard', {
          score, xp: Math.round(score / 15), label: level.label,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        clear(root).append(resultScreen({
          title: missed === 0 ? 'סריקה מושלמת' : missed <= 2 ? 'נסיעה טובה' : 'צריך לסרוק רחב יותר',
          emoji: missed === 0 ? '🦅' : missed <= 2 ? '👁️' : '⚠️',
          score,
          passed: spotted >= Math.ceil(level.count * 0.7),
          stats: [
            ['אותרו', `${spotted}/${level.count}`],
            ['פספוסים', missed],
            ['התראות שווא', falseAlarms],
            ['תגובה ממוצעת', avg ? `${avg.toFixed(2)} שנ׳` : '—'],
            ['המהירה ביותר', bestReaction === Infinity ? '—' : `${bestReaction.toFixed(2)} שנ׳`],
          ],
          outcome,
          onReplay: () => play(level),
          onHome: api.home,
        }));
      }
    }

    return () => { disposed = true; stop(); };
  },
};
