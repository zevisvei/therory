/**
 * Stopping-distance estimation.
 *
 * The player guesses the total distance needed to stop, then sees the real
 * figure split into reaction distance and braking distance. Working with the
 * actual physics (rather than a memorised table) is what builds the intuition
 * that speed hurts quadratically while reaction time only hurts linearly.
 */

import { el, clear, pick, randInt, clamp, hudItem, resultScreen, levelPicker, toast } from '../ui.js';
import { Store } from '../store.js';

const G = 9.81;

const SURFACES = [
  { id: 'dry',    label: 'אספלט יבש',   mu: 0.80, colour: '#64748b', note: 'תנאים אידיאליים' },
  { id: 'wet',    label: 'כביש רטוב',   mu: 0.50, colour: '#3b82f6', note: 'גשם — האחיזה יורדת בכ-40%' },
  { id: 'gravel', label: 'כורכר/חצץ',   mu: 0.38, colour: '#a16207', note: 'שולי דרך לא סלולים' },
  { id: 'ice',    label: 'כביש מכוסה קרח', mu: 0.15, colour: '#67e8f9', note: 'אחיזה מינימלית' },
];

const LEVELS = [
  { id: 'easy',   label: 'מתחיל', desc: 'אספלט יבש בלבד', rounds: 6,  surfaces: ['dry'], reaction: [1.0, 1.0], tolerance: 1.4 },
  { id: 'normal', label: 'רגיל',  desc: 'כל תנאי הדרך',    rounds: 8,  surfaces: null,    reaction: [1.0, 1.0], tolerance: 1.0 },
  { id: 'hard',   label: 'מתקדם', desc: 'זמן תגובה משתנה', rounds: 10, surfaces: null,    reaction: [0.7, 1.6], tolerance: 0.75 },
];

const SLIDER_MAX = 200;

function computeStop(speedKmh, mu, reactionSeconds) {
  const v = speedKmh / 3.6;
  const reactionDist = v * reactionSeconds;
  const brakingDist = (v * v) / (2 * mu * G);
  return { reactionDist, brakingDist, total: reactionDist + brakingDist };
}

export default {
  id: 'distance',
  title: 'מרחק עצירה',
  icon: '📏',
  accent: 'var(--blue)',
  tagline: 'כמה מטרים באמת צריך כדי לעצור? הערכה מול פיזיקה.',

  mount(root, api) {
    let disposed = false;

    showSetup();

    function showSetup() {
      const levels = levelPicker(LEVELS, 'normal');
      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '📏 מרחק עצירה' }),
          el('p', { text: 'מרחק העצירה = מרחק התגובה (עד שהרגל נוגעת בבלם) + מרחק הבלימה. הערך/י את הסכום.' })),
        el('div', { class: 'card stack' }, el('h3', { text: 'רמת קושי' }), levels,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל',
            onClick: () => play(LEVELS.find((l) => l.id === levels.value)),
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(level) {
      let round = 0;
      let score = 0;
      let perfect = 0;
      const errors = [];

      const scoreHud = hudItem('ניקוד', 0);
      const roundHud = hudItem('סיבוב', `1/${level.rounds}`);
      const perfectHud = hudItem('מדויקות', 0, 'good');

      const scenario = el('div', { class: 'stack' });
      const slider = el('input', { type: 'range', min: 5, max: SLIDER_MAX, step: 1, value: 40 });
      const readout = el('b', { text: '40', dir: 'ltr' });
      const sliderBox = el('div', { class: 'slider-wrap stack' },
        el('div', { class: 'spread' },
          el('span', { class: 'muted small', text: 'ההערכה שלך' }),
          el('span', { class: 'row', style: { gap: '4px' } }, readout, el('span', { class: 'muted', text: 'מטר' }))),
        slider,
        el('div', { class: 'spread tiny muted' },
          el('span', { text: '5 מ׳' }), el('span', { text: `${SLIDER_MAX} מ׳` })));

      const ruler = el('div', { class: 'canvas-wrap', style: { display: 'none', background: '#131c2b' } });
      const feedback = el('div', { class: 'feedback', style: { display: 'none' } }, el('strong'), el('span'));
      const submitBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', text: 'זו ההערכה שלי' });
      const nextBtn = el('button', { class: 'btn btn-green btn-lg btn-block', text: 'הבא', style: { display: 'none' } });

      slider.addEventListener('input', () => { readout.textContent = slider.value; });

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, scoreHud, roundHud, perfectHud),
        el('div', { class: 'card stack' }, scenario, sliderBox, submitBtn, nextBtn, ruler, feedback),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: showSetup }),
      ));

      let current = null;
      nextRound();

      function nextRound() {
        if (disposed) return;
        if (round >= level.rounds) return finish();
        round += 1;
        roundHud.setValue(`${round}/${level.rounds}`);

        const surfaces = level.surfaces ? SURFACES.filter((s) => level.surfaces.includes(s.id)) : SURFACES;
        const surface = pick(surfaces);
        const speed = randInt(3, 12) * 10;
        const [rMin, rMax] = level.reaction;
        const reaction = rMin === rMax ? rMin : Math.round((rMin + Math.random() * (rMax - rMin)) * 10) / 10;

        current = { surface, speed, reaction, ...computeStop(speed, surface.mu, reaction) };

        clear(scenario).append(
          el('h3', { text: 'כמה מטרים עד לעצירה מוחלטת?' }),
          el('div', { class: 'result-grid' },
            el('div', { class: 'stat-pill' }, el('b', { text: String(speed), dir: 'ltr' }), el('span', { text: 'קמ״ש' })),
            el('div', { class: 'stat-pill' }, el('b', { text: surface.label.split(' ')[0] }), el('span', { text: 'תנאי הדרך' })),
            el('div', { class: 'stat-pill' }, el('b', { text: reaction.toFixed(1), dir: 'ltr' }), el('span', { text: 'שנ׳ זמן תגובה' }))),
          el('p', { class: 'small muted', text: surface.note }),
        );

        slider.value = String(clamp(Math.round(speed * 0.6), 5, SLIDER_MAX));
        readout.textContent = slider.value;
        slider.disabled = false;
        submitBtn.style.display = '';
        nextBtn.style.display = 'none';
        ruler.style.display = 'none';
        feedback.style.display = 'none';
      }

      submitBtn.addEventListener('click', () => {
        if (!current) return;
        const guess = Number(slider.value);
        const actual = current.total;
        const errPct = Math.abs(guess - actual) / actual * 100;
        errors.push(errPct);

        const scaled = errPct / level.tolerance;
        let points = 0;
        if (scaled < 5) { points = 200; perfect += 1; }
        else if (scaled < 10) points = 150;
        else if (scaled < 20) points = 90;
        else if (scaled < 35) points = 40;
        score += points;

        scoreHud.setValue(score);
        perfectHud.setValue(perfect);

        slider.disabled = true;
        submitBtn.style.display = 'none';
        nextBtn.style.display = '';
        nextBtn.textContent = round >= level.rounds ? 'לסיכום' : 'הבא';

        drawRuler(guess, current);

        feedback.className = `feedback ${points >= 150 ? 'good' : points > 0 ? '' : 'bad'}`;
        feedback.style.display = '';
        feedback.firstChild.textContent = points >= 200
          ? `🎯 מדויק! ${actual.toFixed(1)} מ׳ (+${points})`
          : `המרחק האמיתי: ${actual.toFixed(1)} מ׳ — סטית ב-${errPct.toFixed(0)}% (+${points})`;
        feedback.lastChild.textContent =
          `מרחק תגובה ${current.reactionDist.toFixed(1)} מ׳ (${current.speed} קמ״ש × ${current.reaction} שנ׳) `
          + `+ מרחק בלימה ${current.brakingDist.toFixed(1)} מ׳ (v² ÷ 2·μ·g, כאשר μ=${current.surface.mu}). `
          + 'שימו לב: הכפלת המהירות מכפילה את מרחק הבלימה פי ארבעה.';

        nextBtn.focus();
      });

      nextBtn.addEventListener('click', nextRound);

      function drawRuler(guess, data) {
        const max = Math.max(guess, data.total) * 1.12;
        const pct = (m) => `${(m / max) * 100}%`;

        clear(ruler);
        ruler.style.display = '';
        ruler.append(el('div', { style: { padding: '18px 16px' } },
          el('div', { class: 'spread tiny muted', style: { marginBottom: '6px' } },
            el('span', { text: 'המרחק האמיתי' }),
            el('span', { dir: 'ltr', text: `${data.total.toFixed(1)} m` })),
          el('div', { style: { display: 'flex', height: '26px', borderRadius: '6px', overflow: 'hidden', background: 'var(--line-soft)' } },
            el('div', {
              style: {
                width: pct(data.reactionDist), background: 'var(--amber)', display: 'grid', placeItems: 'center',
                fontSize: '.7rem', fontWeight: '700', color: '#2b1600', whiteSpace: 'nowrap', overflow: 'hidden',
              },
              text: 'תגובה',
            }),
            el('div', {
              style: {
                width: pct(data.brakingDist), background: 'var(--red)', display: 'grid', placeItems: 'center',
                fontSize: '.7rem', fontWeight: '700', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden',
              },
              text: 'בלימה',
            })),
          el('div', { class: 'spread tiny muted', style: { margin: '14px 0 6px' } },
            el('span', { text: 'ההערכה שלך' }),
            el('span', { dir: 'ltr', text: `${guess} m` })),
          el('div', { style: { height: '26px', borderRadius: '6px', background: 'var(--line-soft)', overflow: 'hidden' } },
            el('div', { style: { width: pct(guess), height: '100%', background: 'var(--blue)' } })),
        ));
      }

      function finish() {
        if (perfect >= 5) Store.award('physicist');
        const avgErr = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
        const outcome = Store.finishRun('distance', {
          score, xp: Math.round(score / 16), label: level.label,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        clear(root).append(resultScreen({
          title: avgErr < 12 ? 'תחושת מרחק מצוינת' : avgErr < 25 ? 'לא רע' : 'המרחקים ארוכים ממה שנדמה',
          emoji: avgErr < 12 ? '🎯' : avgErr < 25 ? '📐' : '📏',
          score,
          passed: avgErr < 25,
          stats: [['סטייה ממוצעת', `${avgErr.toFixed(0)}%`], ['הערכות מדויקות', `${perfect}/${level.rounds}`]],
          outcome,
          onReplay: () => play(level),
          onHome: api.home,
        }));
      }
    }

    return () => { disposed = true; };
  },
};
