/**
 * Shell: hash router, home screen, profile header.
 *
 * Every game module exports `mount(root, api)` and may return a cleanup
 * function, which the router calls before swapping screens so timers, RAF
 * loops and document-level key handlers never outlive their screen.
 */

import { $, el, clear, formatDate, toast } from './ui.js';
import { Store, BADGES, levelProgress } from './store.js';

import simulator from './games/simulator.js';
import lights from './games/lights.js';
import rightofway from './games/rightofway.js';
import hazard from './games/hazard.js';
import signs from './games/signs.js';
import distance from './games/distance.js';
import quiz from './games/quiz.js';

const GAMES = [simulator, lights, rightofway, hazard, signs, distance, quiz];
const GAME_BY_ID = Object.fromEntries(GAMES.map((g) => [g.id, g]));

const screen = $('#screen');
let cleanup = null;

/* --------------------------------------------------------------- header */

function renderHeader() {
  const { name, xp, streak } = Store.state;
  const progress = levelProgress(xp);

  $('#profileName').textContent = name;
  $('#profileXp').textContent = `${xp} XP · רמה ${progress.level}`;
  $('#lvlNum').textContent = String(progress.level);
  $('#lvlRing').style.setProperty('--p', progress.pct);
  $('#streakNum').textContent = String(streak.current);
  $('#streakBox').style.opacity = streak.current > 0 ? '1' : '.45';
}

/* ----------------------------------------------------------------- home */

function homeScreen() {
  const { totals, streak } = Store.state;
  const accuracy = totals.answered ? Math.round((totals.correct / totals.answered) * 100) : 0;
  const totalPlays = Object.values(Store.state.games).reduce((sum, g) => sum + g.plays, 0);

  const hero = el('div', { class: 'hero' },
    el('div', {},
      el('h1', { text: 'תרגול נהיגה נכונה' }),
      el('p', { text: 'שבעה תרגולים: מסימולטור טסט עם פסילות ועד מבחן תיאוריה מלא. הניקוד נשמר בדפדפן שלך.' })),
    el('div', { class: 'hero-stats' },
      el('div', { class: 'stat-pill' }, el('b', { text: String(totalPlays), dir: 'ltr' }), el('span', { text: 'סבבים' })),
      el('div', { class: 'stat-pill' }, el('b', { text: `${accuracy}%` }), el('span', { text: 'דיוק כללי' })),
      el('div', { class: 'stat-pill' }, el('b', { text: String(streak.longest), dir: 'ltr' }), el('span', { text: 'רצף שיא' })),
      el('div', { class: 'stat-pill' }, el('b', { text: String(Store.state.badges.length), dir: 'ltr' }), el('span', { text: 'תגים' }))),
  );

  const grid = el('div', { class: 'game-grid' },
    GAMES.map((game) => {
      const best = Store.best(game.id);
      const plays = Store.plays(game.id);
      return el('button', {
        class: 'game-card', type: 'button',
        style: { '--accent': game.accent },
        onClick: () => { location.hash = `#/game/${game.id}`; },
      },
        el('span', { class: 'gc-icon', text: game.icon }),
        el('h3', { text: game.title }),
        el('p', { text: game.tagline }),
        el('div', { class: 'gc-best' },
          el('span', {}, 'שיא: ', el('b', { text: String(best), dir: 'ltr' })),
          el('span', { text: plays ? `${plays} סבבים` : 'טרם שוחק' })),
      );
    }));

  return el('div', { class: 'stack' },
    hero,
    grid,
    el('div', { class: 'row', style: { marginTop: '10px' } },
      el('button', { class: 'btn btn-sm', text: '🏅 תגים והיסטוריה', onClick: () => { location.hash = '#/stats'; } }),
      el('button', { class: 'btn btn-sm btn-ghost', text: '✏️ שינוי שם', onClick: promptName })),
  );
}

function promptName() {
  const current = Store.state.name;
  const value = window.prompt('איך לקרוא לך?', current);
  if (value != null) {
    Store.setName(value);
    renderHeader();
    toast('השם עודכן');
    route();
  }
}

/* ---------------------------------------------------------------- stats */

function statsScreen() {
  const { history, byCategory, totals, badges } = Store.state;

  const badgeGrid = el('div', { class: 'badge-grid' },
    BADGES.map((b) => el('div', { class: `badge ${badges.includes(b.id) ? 'earned' : ''}`.trim() },
      el('div', { class: 'b-ico', text: b.icon }),
      el('div', { class: 'b-name', text: b.name }),
      el('div', { class: 'b-desc', text: b.desc }))));

  const categoryRows = Object.entries(byCategory).map(([code, s]) => {
    const label = { laws: 'חוקי התנועה', signs: 'תמרורים', safety: 'בטיחות', vehicle: 'הכרת הרכב', rightofway: 'זכות קדימה' }[code] || code;
    const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
    return el('tr', {},
      el('td', { text: label }),
      el('td', {}, el('b', { text: `${s.correct}/${s.answered}`, dir: 'ltr' })),
      el('td', {}, el('b', { text: `${pct}%`, dir: 'ltr' })));
  });

  const historyRows = history.slice(0, 25).map((h) => el('tr', {},
    el('td', { text: GAME_BY_ID[h.g]?.title || h.g }),
    el('td', { text: h.l || '—' }),
    el('td', {}, el('b', { text: String(h.s), dir: 'ltr' })),
    el('td', { class: 'tiny muted', text: formatDate(h.t) })));

  return el('div', { class: 'stack' },
    el('div', { class: 'page-head' },
      el('h1', { text: '🏅 התקדמות' }),
      el('p', { text: `${totals.correct} תשובות נכונות מתוך ${totals.answered}.` })),

    el('div', { class: 'card stack' }, el('h3', { text: 'תגים' }), badgeGrid),

    categoryRows.length
      ? el('div', { class: 'card stack' }, el('h3', { text: 'דיוק לפי נושא' }),
          el('div', { class: 'table-scroll' }, el('table', { class: 'hist' },
            el('thead', {}, el('tr', {}, el('th', { text: 'נושא' }), el('th', { text: 'נכונות' }), el('th', { text: 'דיוק' }))),
            el('tbody', {}, categoryRows))))
      : null,

    historyRows.length
      ? el('div', { class: 'card stack' }, el('h3', { text: 'סבבים אחרונים' }),
          el('div', { class: 'table-scroll' }, el('table', { class: 'hist' },
            el('thead', {}, el('tr', {}, el('th', { text: 'תרגול' }), el('th', { text: 'מצב' }), el('th', { text: 'ניקוד' }), el('th', { text: 'מתי' }))),
            el('tbody', {}, historyRows))))
      : el('div', { class: 'card' }, el('p', { class: 'muted center', text: 'עדיין אין היסטוריה. התחל/י לתרגל.' })),

    el('div', { class: 'row' },
      el('button', { class: 'btn', text: '← לתפריט', onClick: () => { location.hash = '#/'; } }),
      el('button', {
        class: 'btn btn-red btn-sm', text: 'איפוס כל ההתקדמות',
        onClick: () => {
          if (window.confirm('לאפס את כל הניקוד, התגים וההיסטוריה? אי אפשר לבטל.')) {
            Store.reset();
            renderHeader();
            location.hash = '#/';
            toast('ההתקדמות אופסה');
          }
        },
      })),
  );
}

/* --------------------------------------------------------------- router */

function route() {
  if (cleanup) { try { cleanup(); } catch { /* a screen that failed to clean up must not block navigation */ } }
  cleanup = null;

  const hash = location.hash || '#/';
  const gameMatch = /^#\/game\/([a-z]+)$/.exec(hash);

  clear(screen);
  window.scrollTo({ top: 0 });

  if (gameMatch && GAME_BY_ID[gameMatch[1]]) {
    const game = GAME_BY_ID[gameMatch[1]];
    document.title = `${game.title} · מסלול`;
    cleanup = game.mount(screen, {
      home: () => { location.hash = '#/'; },
      gameCount: GAMES.length,
    }) || null;
  } else if (hash === '#/stats') {
    document.title = 'התקדמות · מסלול';
    screen.append(statsScreen());
  } else {
    document.title = 'מסלול · תרגול נהיגה';
    screen.append(homeScreen());
  }

  screen.focus({ preventScroll: true });
}

/* ----------------------------------------------------------------- boot */

$('#homeBtn').addEventListener('click', () => { location.hash = '#/'; });
$('#profileChip').addEventListener('click', () => { location.hash = '#/stats'; });
window.addEventListener('hashchange', route);
Store.subscribe(renderHeader);

renderHeader();
route();
