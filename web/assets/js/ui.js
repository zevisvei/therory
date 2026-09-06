/** Small DOM/format helpers shared by every screen. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Creates an element. `props` maps to properties, `dataset`/`attrs` to those. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      // setProperty is required for custom properties; assignment silently drops them.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Fisher-Yates, on a copy. */
export function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function sample(arr, n) {
  return shuffle(arr).slice(0, n);
}

export function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })
    + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

export function toast(message, kind = '') {
  const box = $('#toaster');
  if (!box) return;
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  box.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .35s, transform .35s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(10px)';
    setTimeout(() => node.remove(), 380);
  }, kind === 'gold' ? 3200 : 2200);
}

/** requestAnimationFrame loop with a delta clamped against tab-switch jumps. */
export function loop(step) {
  let raf = 0;
  let last = performance.now();
  let running = true;

  const frame = (now) => {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => { running = false; cancelAnimationFrame(raf); };
}

/** Sizes a canvas to its CSS box at device pixel ratio. Returns the context. */
export function fitCanvas(canvas, cssWidth, cssHeight) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.aspectRatio = `${cssWidth} / ${cssHeight}`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Maps a pointer event to canvas logical (pre-DPR) coordinates. */
export function pointerPos(canvas, event, logicalWidth, logicalHeight) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * logicalWidth,
    y: ((event.clientY - rect.top) / rect.height) * logicalHeight,
  };
}

export function hudItem(label, value, kind = '') {
  const b = el('b', { text: String(value) });
  const node = el('div', { class: `hud-item ${kind}`.trim() }, el('span', { class: 'muted small', text: label }), b);
  node.setValue = (v, k) => {
    b.textContent = String(v);
    if (k !== undefined) node.className = `hud-item ${k}`.trim();
  };
  return node;
}

export function timerBar() {
  const fill = el('i');
  const bar = el('div', { class: 'timerbar' }, fill);
  bar.setRatio = (r) => {
    const v = clamp(r, 0, 1);
    fill.style.transform = `scaleX(${v})`;
    bar.classList.toggle('low', v < 0.25);
  };
  return bar;
}

export function loadingScreen(text = 'טוען…') {
  return el('div', { class: 'loading' }, el('div', { class: 'spinner' }), el('p', { text }));
}

/** Standard end-of-run screen. `stats` is a list of [label, value] pairs. */
export function resultScreen({ title, emoji, score, passed, stats = [], detail = null, outcome, onReplay, onHome }) {
  const hero = el('div', { class: `result-hero ${passed === false ? 'fail' : passed === true ? 'pass' : ''}`.trim() },
    el('div', { class: 'rh-emoji', text: emoji }),
    el('h2', { text: title }),
    el('div', { class: 'rh-score', text: String(score), dir: 'ltr' }),
    el('p', { class: 'muted', text: 'נקודות' }),
  );

  const grid = el('div', { class: 'result-grid' },
    stats.map(([label, value]) => el('div', { class: 'stat-pill' },
      el('b', { text: String(value), dir: 'ltr' }), el('span', { text: label }))),
  );

  const notes = el('div', { class: 'stack' });
  if (outcome?.isBest) notes.append(el('div', { class: 'feedback good', text: '🏆 שיא אישי חדש!' }));
  if (outcome?.levelUp) notes.append(el('div', { class: 'feedback good', text: `⬆️ עלית לרמה ${outcome.levelUp}!` }));

  const xpWrap = outcome?.progress
    ? el('div', { class: 'card tight' },
        el('div', { class: 'spread' },
          el('span', { class: 'small muted', text: `רמה ${outcome.progress.level}` }),
          el('span', { class: 'small muted', dir: 'ltr', text: `${outcome.progress.into} / ${outcome.progress.need} XP` })),
        el('div', { class: 'xp-bar' }, el('i', { style: { width: `${outcome.progress.pct}%` } })))
    : null;

  return el('div', { class: 'stack' },
    el('div', { class: 'card' }, hero, grid),
    detail,
    notes,
    xpWrap,
    el('div', { class: 'row' },
      el('button', { class: 'btn btn-primary btn-lg grow', text: 'שוב 🔁', onClick: onReplay }),
      el('button', { class: 'btn btn-lg', text: 'לתפריט', onClick: onHome })),
  );
}

/** Toggle-chip group. Returns the element; read `.value` for selected ids. */
export function chipGroup(items, { multi = true, initial = [] } = {}) {
  const selected = new Set(initial);
  const wrap = el('div', { class: 'chips' });

  items.forEach((item) => {
    const chip = el('button', { class: 'chip', type: 'button' },
      item.label,
      item.count != null ? el('span', { class: 'chip-n', text: `(${item.count})`, dir: 'ltr' }) : null);
    chip.setAttribute('aria-pressed', String(selected.has(item.id)));
    chip.addEventListener('click', () => {
      if (multi) {
        if (selected.has(item.id)) selected.delete(item.id); else selected.add(item.id);
      } else {
        selected.clear();
        selected.add(item.id);
      }
      [...wrap.children].forEach((c, i) => c.setAttribute('aria-pressed', String(selected.has(items[i].id))));
      wrap.dispatchEvent(new CustomEvent('change'));
    });
    wrap.append(chip);
  });

  Object.defineProperty(wrap, 'value', { get: () => [...selected] });
  return wrap;
}

/** Radio-style level picker. Returns the element; read `.value` for the id. */
export function levelPicker(levels, initial) {
  let current = initial ?? levels[0].id;
  const wrap = el('div', { class: 'level-grid' });

  levels.forEach((lvl) => {
    const btn = el('button', { class: 'level-opt', type: 'button' },
      el('strong', { text: lvl.label }), el('span', { text: lvl.desc }));
    btn.setAttribute('aria-pressed', String(lvl.id === current));
    btn.addEventListener('click', () => {
      current = lvl.id;
      [...wrap.children].forEach((c, i) => c.setAttribute('aria-pressed', String(levels[i].id === current)));
      wrap.dispatchEvent(new CustomEvent('change'));
    });
    wrap.append(btn);
  });

  Object.defineProperty(wrap, 'value', { get: () => current });
  return wrap;
}
