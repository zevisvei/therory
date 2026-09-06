/**
 * Traffic-light reflex drill.
 *
 * Each round shows one real Israeli signal state and the player picks the
 * lawful response under time pressure. The states that actually trip people up
 * — flashing green, flashing amber, a dead signal, a green arrow on red — are
 * weighted more heavily than plain red/green.
 */

import { el, clear, pick, clamp, hudItem, timerBar, resultScreen, levelPicker, toast } from '../ui.js';
import { Store } from '../store.js';

const ARROW_SVG = (rotate) => `
<svg viewBox="0 0 24 24" fill="none" stroke="#05210f" stroke-width="3.2"
     stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rotate}deg)">
  <path d="M5 12h13"/><path d="m12 6 6 6-6 6"/>
</svg>`;

const STATES = [
  {
    id: 'green', weight: 3, name: 'אור ירוק',
    lamps: { green: 'on' }, action: 'go',
    why: 'ירוק קבוע — מותר להמשיך, ובתנאי שהצומת פנוי ואפשר לפנות אותו.',
  },
  {
    id: 'green_flash', weight: 4, name: 'ירוק מהבהב',
    lamps: { green: 'blink' }, action: 'slow',
    why: 'הירוק המהבהב מודיע שהאור עומד להתחלף לצהוב. מאיטים ומתכוננים לעצור — לא מאיצים כדי "להספיק".',
  },
  {
    id: 'amber', weight: 3, name: 'אור צהוב',
    lamps: { amber: 'on' }, action: 'stop',
    why: 'צהוב קבוע — יש לעצור לפני קו העצירה. ממשיכים רק אם העצירה כבר בלתי אפשרית בבטחה.',
  },
  {
    id: 'red', weight: 3, name: 'אור אדום',
    lamps: { red: 'on' }, action: 'stop',
    why: 'אדום — עצירה מוחלטת לפני קו העצירה, גם אם הצומת נראה ריק.',
  },
  {
    id: 'amber_flash', weight: 4, name: 'צהוב מהבהב',
    lamps: { amber: 'blink' }, action: 'slow',
    why: 'הרמזור אינו מכוון את התנועה. הצומת הופך לצומת רגיל — מאטים, נותנים זכות קדימה ועוברים בזהירות.',
  },
  {
    id: 'dark', weight: 3, name: 'רמזור כבוי',
    lamps: {}, action: 'slow',
    why: 'רמזור מושבת — נוהגים לפי התמרורים שבצומת, ובהיעדרם לפי כלל זכות הקדימה מימין. להאט ולעבור בזהירות.',
  },
  {
    id: 'arrow_right', weight: 3, name: 'אדום עם חץ ירוק ימינה',
    lamps: { red: 'on' }, arrow: { dir: 'right', state: 'on' }, action: 'go',
    why: 'החץ הירוק מתיר תנועה בכיוון החץ בלבד. פונים ימינה — אך אסור להמשיך ישר.',
  },
  {
    id: 'arrow_left', weight: 2, name: 'אדום עם חץ ירוק שמאלה',
    lamps: { red: 'on' }, arrow: { dir: 'left', state: 'on' }, action: 'go',
    why: 'החץ הירוק מתיר פנייה שמאלה בלבד, והתנועה הנגדית עצורה. שאר הכיוונים אסורים.',
  },
  {
    id: 'red_amber_trap', weight: 2, name: 'אדום וצהוב יחד',
    lamps: { red: 'on', amber: 'on' }, action: 'stop',
    why: 'בישראל אין שלב "אדום וצהוב" שמתיר יציאה. כל עוד האדום דולק — עוצרים.',
  },
];

const LEVELS = [
  { id: 'easy',   label: 'מתחיל',  desc: '3.0 שניות לתגובה', limit: 3000, rounds: 16 },
  { id: 'normal', label: 'רגיל',   desc: '2.0 שניות לתגובה', limit: 2000, rounds: 20 },
  { id: 'hard',   label: 'מהיר',   desc: '1.2 שניות לתגובה', limit: 1200, rounds: 24 },
];

const ACTIONS = [
  { id: 'stop', label: 'עצור',  icon: '🛑', key: '1' },
  { id: 'slow', label: 'האט',   icon: '⚠️', key: '2' },
  { id: 'go',   label: 'סע',    icon: '✅', key: '3' },
];

const LIVES = 3;

function weightedState(exclude) {
  const pool = STATES.filter((s) => s.id !== exclude);
  const total = pool.reduce((sum, s) => sum + s.weight, 0);
  let roll = Math.random() * total;
  for (const s of pool) {
    roll -= s.weight;
    if (roll <= 0) return s;
  }
  return pool[pool.length - 1];
}

export default {
  id: 'lights',
  title: 'רמזור מהיר',
  icon: '⚡',
  accent: 'var(--amber)',
  tagline: 'ירוק מהבהב, צהוב מהבהב, חץ ירוק — לזהות ולהגיב בשנייה.',

  mount(root, api) {
    let disposed = false;
    let teardownRound = () => {};
    const timers = new Set();
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.add(t); return t; };
    const clearTimers = () => { timers.forEach(clearTimeout); timers.clear(); };

    showSetup();

    function showSetup() {
      clearTimers();
      teardownRound();
      const levels = levelPicker(LEVELS, 'normal');

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '⚡ רמזור מהיר' }),
          el('p', { text: 'הרמזור מציג מצב — בחר/י את התגובה הנכונה לפני שהזמן נגמר. שלושה חיים.' })),
        el('div', { class: 'card stack' },
          el('h3', { text: 'רמת קושי' }),
          levels,
          el('div', { class: 'divider' }),
          el('p', { class: 'small muted', text: 'מקלדת: 1 = עצור · 2 = האט · 3 = סע' }),
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל',
            onClick: () => play(LEVELS.find((l) => l.id === levels.value)),
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(level) {
      clearTimers();
      teardownRound();

      let round = 0;
      let score = 0;
      let lives = LIVES;
      let streak = 0;
      let bestStreak = 0;
      let correct = 0;
      let fastest = Infinity;
      let locked = true;
      let shownAt = 0;
      let current = null;
      let blinkTimer = null;
      let tickTimer = null;

      const scoreHud = hudItem('ניקוד', 0);
      const streakHud = hudItem('רצף', 0, 'good');
      const roundHud = hudItem('סיבוב', `0/${level.rounds}`);
      const livesHud = el('div', { class: 'hud-item' },
        el('span', { class: 'muted small', text: 'חיים' }),
        el('b', { class: 'lives', text: '❤️'.repeat(LIVES) }));

      const bar = timerBar();

      const lamps = {
        red: el('div', { class: 'tl-lamp red' }),
        amber: el('div', { class: 'tl-lamp amber' }),
        green: el('div', { class: 'tl-lamp green' }),
      };
      const arrowLamp = el('div', { class: 'tl-lamp green', style: { display: 'none' } });

      const housing = el('div', { class: 'tl-housing' }, lamps.red, lamps.amber, lamps.green, arrowLamp);
      const stage = el('div', { class: 'light-stage' }, housing);

      const buttons = ACTIONS.map((a) => el('button', {
        class: 'action-btn', type: 'button', dataset: { act: a.id },
        onClick: () => answer(a.id),
      },
        el('span', { class: 'ab-ico', text: a.icon }),
        el('span', { text: a.label }),
        el('span', { class: 'ab-key', text: `מקש ${a.key}` }),
      ));

      const feedback = el('div', { class: 'feedback', style: { visibility: 'hidden' } }, el('strong', { text: '—' }), el('span'));

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, scoreHud, streakHud, roundHud, livesHud),
        bar,
        el('div', { class: 'card' }, stage, el('div', { class: 'action-row' }, buttons), feedback),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stopRound(); showSetup(); } }),
      ));

      document.addEventListener('keydown', onKey);
      teardownRound = stopRound;

      function onKey(e) {
        const action = ACTIONS.find((a) => a.key === e.key);
        if (action && !locked) { e.preventDefault(); answer(action.id); }
      }

      function paint(state) {
        for (const [colour, lamp] of Object.entries(lamps)) {
          lamp.classList.toggle('on', state.lamps[colour] === 'on');
        }
        arrowLamp.style.display = state.arrow ? '' : 'none';
        if (state.arrow) {
          arrowLamp.innerHTML = ARROW_SVG(state.arrow.dir === 'right' ? 0 : 180);
          arrowLamp.classList.add('on');
        } else {
          arrowLamp.classList.remove('on');
        }

        const blinking = Object.entries(state.lamps).find(([, v]) => v === 'blink');
        if (blinking) {
          let visible = true;
          blinkTimer = setInterval(() => {
            visible = !visible;
            lamps[blinking[0]].classList.toggle('on', visible);
          }, 450);
        }
      }

      function stopRound() {
        clearInterval(blinkTimer); blinkTimer = null;
        clearInterval(tickTimer); tickTimer = null;
        document.removeEventListener('keydown', onKey);
      }

      function nextRound() {
        if (disposed) return;
        clearInterval(blinkTimer); blinkTimer = null;
        clearInterval(tickTimer); tickTimer = null;

        if (round >= level.rounds || lives <= 0) return finish();

        round += 1;
        roundHud.setValue(`${round}/${level.rounds}`);
        feedback.style.visibility = 'hidden';
        buttons.forEach((b) => b.classList.remove('flash-good', 'flash-bad'));

        // A blank pause before the signal appears stops players pre-committing.
        for (const lamp of Object.values(lamps)) lamp.classList.remove('on');
        arrowLamp.style.display = 'none';
        bar.setRatio(1);
        locked = true;

        later(() => {
          if (disposed) return;
          current = weightedState(current?.id);
          paint(current);
          shownAt = performance.now();
          locked = false;

          tickTimer = setInterval(() => {
            const left = 1 - (performance.now() - shownAt) / level.limit;
            bar.setRatio(left);
            if (left <= 0) { clearInterval(tickTimer); answer(null); }
          }, 50);
        }, 450 + Math.random() * 700);
      }

      function answer(action) {
        if (locked || !current) return;
        locked = true;
        clearInterval(tickTimer); tickTimer = null;
        clearInterval(blinkTimer); blinkTimer = null;

        const reaction = performance.now() - shownAt;
        const isCorrect = action === current.action;

        if (isCorrect) {
          correct += 1;
          streak += 1;
          bestStreak = Math.max(bestStreak, streak);
          fastest = Math.min(fastest, reaction);

          const speedBonus = Math.round(100 * clamp(1 - reaction / level.limit, 0, 1));
          const multiplier = Math.min(3, 1 + Math.floor(streak / 5) * 0.5);
          score += Math.round((100 + speedBonus) * multiplier);

          scoreHud.setValue(score);
          streakHud.setValue(streak);

          buttons.find((b) => b.dataset.act === action)?.classList.add('flash-good');
          feedback.className = 'feedback good';
          feedback.style.visibility = 'visible';
          feedback.firstChild.textContent = `✅ ${current.name} · ${Math.round(reaction)} מ״ש${multiplier > 1 ? ` · ×${multiplier}` : ''}`;
          feedback.lastChild.textContent = current.why;
        } else {
          lives -= 1;
          streak = 0;
          streakHud.setValue(0);
          livesHud.querySelector('b').textContent = '❤️'.repeat(Math.max(0, lives)) + '🖤'.repeat(LIVES - Math.max(0, lives));

          if (action) buttons.find((b) => b.dataset.act === action)?.classList.add('flash-bad');
          buttons.find((b) => b.dataset.act === current.action)?.classList.add('flash-good');

          feedback.className = 'feedback bad';
          feedback.style.visibility = 'visible';
          feedback.firstChild.textContent = action
            ? `❌ ${current.name} — התשובה הנכונה: ${ACTIONS.find((a) => a.id === current.action).label}`
            : `⏱️ נגמר הזמן — ${current.name}. הנכונה: ${ACTIONS.find((a) => a.id === current.action).label}`;
          feedback.lastChild.textContent = current.why;
        }

        // Hold the light steadily (no blinking) while the explanation is read.
        for (const colour of Object.keys(current.lamps)) lamps[colour].classList.add('on');

        later(nextRound, isCorrect ? 1100 : 2600);
      }

      function finish() {
        stopRound();
        const accuracy = round ? Math.round((correct / round) * 100) : 0;
        const xp = Math.round(score / 12);

        if (fastest < 350) Store.award('reflex');
        if (score >= 1500) Store.award('light_master');

        const outcome = Store.finishRun('lights', { score, xp, label: level.label });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        clear(root).append(resultScreen({
          title: lives > 0 ? 'סיימת את הסבב' : 'נגמרו החיים',
          emoji: accuracy >= 90 ? '🏁' : accuracy >= 70 ? '👍' : '🚧',
          score,
          passed: accuracy >= 70,
          stats: [
            ['דיוק', `${accuracy}%`],
            ['נכונות', `${correct}/${round}`],
            ['רצף שיא', bestStreak],
            ['תגובה מהירה', fastest === Infinity ? '—' : `${Math.round(fastest)} מ״ש`],
          ],
          outcome,
          onReplay: () => play(level),
          onHome: api.home,
        }));
      }

      nextRound();
    }

    return () => {
      disposed = true;
      clearTimers();
      teardownRound();
    };
  },
};
