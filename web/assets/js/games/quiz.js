/**
 * Full theory quiz over the exported bank (1,802 questions).
 *
 * Two modes: practice, which marks every answer immediately, and exam, which
 * mirrors the real Israeli test — 30 questions, 40 minutes, pass at 26 correct.
 */

import { el, clear, hudItem, timerBar, resultScreen, levelPicker, chipGroup, loadingScreen, toast } from '../ui.js';
import { loadBank, filterQuestions, presentQuestion, CATEGORY_LABELS, LICENCES } from '../data.js';
import { Store } from '../store.js';

const EXAM_SIZE = 30;
const EXAM_PASS = 26;
const EXAM_MINUTES = 40;

const MODES = [
  { id: 'practice', label: 'אימון', desc: 'משוב מיידי אחרי כל שאלה' },
  { id: 'exam',     label: 'מבחן',  desc: `${EXAM_SIZE} שאלות · ${EXAM_MINUTES} דק׳ · עוברים ב-${EXAM_PASS}` },
];

const SIZES = [10, 20, 30, 50];

export default {
  id: 'quiz',
  title: 'מבחן תיאוריה',
  icon: '📚',
  accent: 'var(--red)',
  tagline: '1,802 שאלות רשמיות. אימון לפי נושא או מבחן מלא בתנאי אמת.',

  mount(root, api) {
    let disposed = false;
    let stopClock = () => {};

    clear(root).append(loadingScreen('טוען את מאגר השאלות…'));

    loadBank().then((bank) => {
      if (!disposed) showSetup(bank);
    }).catch((err) => {
      if (disposed) return;
      clear(root).append(el('div', { class: 'card stack' },
        el('h3', { text: 'שגיאה בטעינת המאגר' }),
        el('p', { class: 'muted small', text: String(err.message || err) }),
        el('button', { class: 'btn', text: 'חזרה', onClick: api.home })));
    });

    function showSetup(bank) {
      stopClock();
      const saved = Store.extra('quiz');

      const categories = chipGroup(
        Object.entries(CATEGORY_LABELS).map(([id, label]) => ({
          id, label, count: bank.byCategory[id]?.length ?? 0,
        })),
        { multi: true, initial: saved.categories?.length ? saved.categories : Object.keys(CATEGORY_LABELS) },
      );

      const licences = chipGroup(LICENCES, { multi: false, initial: [saved.licence || 'B'] });
      const sizes = chipGroup(SIZES.map((n) => ({ id: String(n), label: `${n} שאלות` })), { multi: false, initial: [String(saved.size || 20)] });
      const modes = levelPicker(MODES, saved.mode || 'practice');

      const sizeRow = el('div', { class: 'stack' }, el('h3', { text: 'מספר שאלות' }), sizes);
      const syncSizeVisibility = () => { sizeRow.style.display = modes.value === 'exam' ? 'none' : ''; };
      modes.addEventListener('change', syncSizeVisibility);
      syncSizeVisibility();

      const available = el('p', { class: 'small muted' });
      const refreshCount = () => {
        const n = filterQuestions(bank, { categories: categories.value, licence: licences.value[0] }).length;
        available.textContent = `${n} שאלות תואמות את הסינון.`;
      };
      categories.addEventListener('change', refreshCount);
      licences.addEventListener('change', refreshCount);
      refreshCount();

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'page-head' },
          el('h1', { text: '📚 מבחן תיאוריה' }),
          el('p', { text: 'בחר/י נושאים, סוג רישיון ומצב תרגול.' })),
        el('div', { class: 'card stack' },
          el('h3', { text: 'מצב' }), modes,
          el('div', { class: 'divider' }),
          el('h3', { text: 'נושאים' }), categories,
          el('div', { class: 'divider' }),
          el('h3', { text: 'סוג רישיון' }), licences,
          el('div', { class: 'divider' }),
          sizeRow,
          available,
          el('button', {
            class: 'btn btn-primary btn-lg btn-block', text: 'התחל',
            onClick: () => {
              const mode = modes.value;
              const cats = categories.value.length ? categories.value : Object.keys(CATEGORY_LABELS);
              const licence = licences.value[0];
              const size = mode === 'exam' ? EXAM_SIZE : Number(sizes.value[0]);
              Store.setExtra('quiz', { categories: cats, licence, size: Number(sizes.value[0]), mode });

              const deck = filterQuestions(bank, { categories: cats, licence, limit: size }).map(presentQuestion);
              if (!deck.length) { toast('אין שאלות שתואמות את הסינון'); return; }
              play(bank, deck, mode);
            },
          })),
        el('button', { class: 'btn btn-ghost', text: '← חזרה', onClick: api.home }),
      ));
    }

    function play(bank, deck, mode) {
      stopClock();
      stopClock = () => {};
      const isExam = mode === 'exam';

      let index = 0;
      let correct = 0;
      const answers = new Array(deck.length).fill(null);

      const progressHud = hudItem('שאלה', `1/${deck.length}`);
      const correctHud = hudItem('נכונות', 0, 'good');
      const clockHud = isExam ? hudItem('זמן', `${EXAM_MINUTES}:00`) : null;
      const bar = timerBar();
      bar.setRatio(0);

      const image = el('img', { class: 'q-image', alt: 'תמונת השאלה', loading: 'lazy', decoding: 'async' });
      const question = el('h3');
      const options = el('div', { class: 'options' });
      const feedback = el('div', { class: 'feedback', style: { display: 'none' } }, el('strong'), el('span'));
      const nextBtn = el('button', { class: 'btn btn-primary btn-lg btn-block', text: 'הבא', style: { display: 'none' } });
      const skipBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'דלג/י' });

      clear(root).append(el('div', { class: 'stack' },
        el('div', { class: 'hud' }, progressHud, correctHud, clockHud),
        bar,
        el('div', { class: 'card' }, image, question, options, feedback, nextBtn),
        el('div', { class: 'spread' },
          el('button', { class: 'btn btn-ghost btn-sm', text: '← יציאה', onClick: () => { stopClock(); showSetup(bank); } }),
          skipBtn),
      ));

      if (isExam) {
        const endsAt = Date.now() + EXAM_MINUTES * 60000;
        const tick = setInterval(() => {
          const left = Math.max(0, endsAt - Date.now());
          const m = Math.floor(left / 60000);
          const s = Math.floor((left % 60000) / 1000);
          clockHud.setValue(`${m}:${String(s).padStart(2, '0')}`, left < 300000 ? 'bad' : '');
          if (left <= 0) { clearInterval(tick); finish(); }
        }, 500);
        stopClock = () => clearInterval(tick);
      }

      document.addEventListener('keydown', onKey);
      const prevStop = stopClock;
      stopClock = () => { prevStop(); document.removeEventListener('keydown', onKey); };

      function onKey(e) {
        const n = Number(e.key);
        if (n >= 1 && n <= options.children.length && !options.children[n - 1].disabled) {
          e.preventDefault();
          options.children[n - 1].click();
        } else if (e.key === 'Enter' && nextBtn.style.display !== 'none') {
          e.preventDefault();
          nextBtn.click();
        }
      }

      skipBtn.addEventListener('click', () => { index += 1; render(); });
      nextBtn.addEventListener('click', () => { index += 1; render(); });

      render();

      function render() {
        if (disposed) return;
        if (index >= deck.length) return finish();

        const q = deck[index];
        progressHud.setValue(`${index + 1}/${deck.length}`);
        bar.setRatio((index) / deck.length);
        feedback.style.display = 'none';
        nextBtn.style.display = 'none';

        if (q.image) {
          image.style.display = '';
          image.src = q.image;
          image.onerror = () => { image.style.display = 'none'; };
        } else {
          image.style.display = 'none';
          image.removeAttribute('src');
        }

        question.textContent = q.text;

        clear(options);
        q.options.forEach((text, i) => {
          options.append(el('button', {
            class: 'opt', type: 'button', onClick: () => choose(q, i),
          }, el('span', { class: 'opt-key', text: String(i + 1) }), el('span', { text })));
        });
      }

      function choose(q, chosen) {
        if (answers[index] != null) return;
        answers[index] = chosen;
        const isCorrect = chosen === q.answer;
        if (isCorrect) correct += 1;
        correctHud.setValue(correct);
        Store.logAnswer(q.category, isCorrect);

        const buttons = [...options.children];

        if (isExam) {
          // No marking during the exam; just move on.
          buttons.forEach((b) => { b.disabled = true; });
          buttons[chosen].classList.add('correct');
          setTimeout(() => { if (!disposed) { index += 1; render(); } }, 180);
          return;
        }

        buttons.forEach((b, i) => {
          b.disabled = true;
          if (i === q.answer) b.classList.add('correct');
          else if (i === chosen) b.classList.add('wrong');
        });

        feedback.className = `feedback ${isCorrect ? 'good' : 'bad'}`;
        feedback.style.display = '';
        feedback.firstChild.textContent = isCorrect ? '✅ נכון' : '❌ לא נכון';
        feedback.lastChild.textContent = isCorrect
          ? CATEGORY_LABELS[q.category] || ''
          : `התשובה הנכונה: ${q.options[q.answer]}`;
        nextBtn.style.display = '';
        nextBtn.textContent = index + 1 >= deck.length ? 'לסיכום' : 'הבא';
        nextBtn.focus();
      }

      function finish() {
        stopClock();
        const answered = answers.filter((a) => a != null).length;
        const accuracy = deck.length ? Math.round((correct / deck.length) * 100) : 0;
        const passed = isExam ? correct >= EXAM_PASS : accuracy >= 80;
        const score = correct * (isExam ? 40 : 25);

        const outcome = Store.finishRun('quiz', {
          score, xp: correct * (isExam ? 6 : 4), label: isExam ? 'מבחן' : 'אימון', passed,
        });
        outcome.newBadges.forEach((b) => toast(`${b.icon} תג חדש: ${b.name}`, 'gold'));

        const wrongList = deck
          .map((q, i) => ({ q, chosen: answers[i] }))
          .filter(({ q, chosen }) => chosen == null || chosen !== q.answer);

        const review = wrongList.length
          ? el('div', { class: 'card stack' },
              el('h3', { text: `לחזרה (${wrongList.length})` }),
              ...wrongList.slice(0, 20).map(({ q, chosen }) => el('div', { class: 'feedback bad' },
                el('strong', { text: q.text }),
                el('span', { text: `✔ ${q.options[q.answer]}${chosen != null ? `   ✘ ${q.options[chosen]}` : '   (לא נענתה)'}` }))))
          : null;

        clear(root).append(resultScreen({
          title: isExam ? (passed ? 'עברת את המבחן' : 'לא עברת הפעם') : 'סיימת את התרגול',
          emoji: passed ? '🎓' : '📖',
          score,
          passed,
          stats: [
            ['נכונות', `${correct}/${deck.length}`],
            ['דיוק', `${accuracy}%`],
            ['נענו', `${answered}/${deck.length}`],
            ...(isExam ? [['סף מעבר', EXAM_PASS]] : []),
          ],
          detail: review,
          outcome,
          onReplay: () => showSetup(bank),
          onHome: api.home,
        }));
      }
    }

    return () => { disposed = true; stopClock(); };
  },
};
