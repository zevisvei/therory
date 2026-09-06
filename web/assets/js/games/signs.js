/**
 * Sign-recognition sprint, driven by the real signs questions exported from
 * questions.db — 378 of them carry the official image.
 */

import { el, clear, hudItem, timerBar, resultScreen, levelPicker, loadingScreen, toast } from '../ui.js';
import { loadBank, filterQuestions, presentQuestion } from '../data.js';
import { Store } from '../store.js';

const LEVELS = [
  { id: 'easy',   label: 'נינוח',  desc: '90 שניות', seconds: 90 },
  { id: 'normal', label: 'ספרינט', desc: '60 שניות', seconds: 60 },
  { id: 'hard',   label: 'לחץ',    desc: '40 שניות', seconds: 40 },
];

export default {
  id: 'signs',
  title: 'זיהוי תמרורים',
  icon: '🚸',
  accent: 'var(--cyan)',
  tagline: 'תמונות תמרורים אמיתיות. כמה תזהה/י לפני שהזמן נגמר?',

  mount(root, api) {
    let disposed = false;
    let stopClock = () => {};

    clear(root).append(loadingScreen('טוען תמרורים…'));

    loadBank().then((bank) => {
      if (disposed) return;
      const pool = filterQuestions(bank, { categories: ['signs'], withImage: true });
      if (!pool.length) {
        clear(root).append(el('div', { class: 'card' },
          el('p', { text: 'לא נמצאו שאלות תמרורים עם תמונה.' }),
          el('button', { class: 'btn', text: 'חזרה', onClick: api.home })));
        return;
      }
      showSetup(bank, pool);
    }).catch((err) => {
      if (disposed) return;
      clear(root).append(el('div', { class: 'card stack' },
        el('h3', { text: 'שגיאה בטעינת הנתונים' }),
        el('p', { class: 'muted small', text: String(err.message || err) }),
        el('button', { class: 'btn', text: 'חזרה', onClick: api.home })));
    });

    function showSetup(bank, pool) {
      stopClock();
      const levels = levelPicker(LEVELS, 'normal');
      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '🚸 זיהוי תמרורים' }),
          el('p', { text: `${pool.length} תמרורים במאגר. כל תשובה נכונה מוסיפה זמן — רצף מכפיל את הניקוד.` })),
        el('div', { class: 'card stack' }, el('h3', { text: 'אורך הסבב' }), levels,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל',
            onClick: () => play(bank, pool, LEVELS.find((l) => l.id === levels.value)),
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(bank, pool, level) {
      stopClock();

      const deck = filterQuestions(bank, { categories: ['signs'], withImage: true });
      let index = 0;
      let score = 0;
      let correct = 0;
      let asked = 0;
      let streak = 0;
      let bestStreak = 0;
      let locked = false;
      let endsAt = performance.now() + level.seconds * 1000;

      const scoreHud = hudItem('ניקוד', 0);
      const streakHud = hudItem('רצף', 0, 'good');
      const correctHud = hudItem('נכונות', '0');
      const bar = timerBar();

      const image = el('img', { class: 'q-image', alt: 'תמרור', loading: 'eager', decoding: 'async' });
      const question = el('h3');
      const options = el('div', { class: 'options' });
      const feedback = el('div', { class: 'feedback', style: { display: 'none' } }, el('strong'), el('span'));

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, scoreHud, streakHud, correctHud),
        bar,
        el('div', { class: 'card' }, image, question, options, feedback),
        el('button', { class: 'btn btn-ghost', text: '← יציאה', onClick: () => { stopClock(); showSetup(bank, pool); } }),
      ));

      const tick = setInterval(() => {
        const left = (endsAt - performance.now()) / (level.seconds * 1000);
        bar.setRatio(left);
        if (left <= 0) { clearInterval(tick); finish(); }
      }, 60);
      document.addEventListener('keydown', onKey);
      stopClock = () => {
        clearInterval(tick);
        document.removeEventListener('keydown', onKey);
      };

      function onKey(e) {
        const n = Number(e.key);
        if (!locked && n >= 1 && n <= options.children.length) {
          e.preventDefault();
          options.children[n - 1].click();
        }
      }

      next();

      function next() {
        if (disposed) return;
        if (index >= deck.length) index = 0;

        const q = presentQuestion(deck[index++]);
        locked = false;
        feedback.style.display = 'none';

        image.src = q.image;
        image.style.display = '';
        image.onerror = () => { image.style.display = 'none'; };
        question.textContent = q.text;

        clear(options);
        q.options.forEach((text, i) => {
          options.append(el('button', {
            class: 'opt', type: 'button',
            onClick: () => answer(q, i),
          }, el('span', { class: 'opt-key', text: String(i + 1) }), el('span', { text })));
        });
      }

      function answer(q, chosen) {
        if (locked) return;
        locked = true;
        asked += 1;

        const isCorrect = chosen === q.answer;
        const buttons = [...options.children];
        buttons.forEach((b, i) => {
          b.disabled = true;
          if (i === q.answer) b.classList.add('correct');
          else if (i === chosen) b.classList.add('wrong');
        });

        Store.logAnswer('signs', isCorrect);

        if (isCorrect) {
          correct += 1;
          streak += 1;
          bestStreak = Math.max(bestStreak, streak);
          const multiplier = Math.min(4, 1 + Math.floor(streak / 3) * 0.5);
          score += Math.round(100 * multiplier);
          endsAt += 1500; // a correct answer buys a little more time
          scoreHud.setValue(score);
          streakHud.setValue(streak);
          correctHud.setValue(`${correct}/${asked}`);
          if (streak >= 20) Store.award('sign_reader');
          setTimeout(() => { if (!disposed) next(); }, 550);
        } else {
          streak = 0;
          streakHud.setValue(0);
          correctHud.setValue(`${correct}/${asked}`);
          endsAt -= 2000; // and a mistake costs some
          feedback.className = 'feedback bad';
          feedback.style.display = '';
          feedback.firstChild.textContent = 'התשובה הנכונה מסומנת בירוק';
          feedback.lastChild.textContent = q.options[q.answer];
          setTimeout(() => { if (!disposed) next(); }, 1900);
        }
      }

      function finish() {
        stopClock();
        const accuracy = asked ? Math.round((correct / asked) * 100) : 0;
        const outcome = Store.finishRun('signs', {
          score, xp: Math.round(score / 14), label: level.label,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        clear(root).append(resultScreen({
          title: 'נגמר הזמן',
          emoji: accuracy >= 85 ? '🥇' : accuracy >= 65 ? '🚸' : '📖',
          score,
          passed: accuracy >= 70,
          stats: [['דיוק', `${accuracy}%`], ['נכונות', `${correct}/${asked}`], ['רצף שיא', bestStreak]],
          outcome,
          onReplay: () => play(bank, pool, level),
          onHome: api.home,
        }));
      }
    }

    return () => { disposed = true; stopClock(); };
  },
};
