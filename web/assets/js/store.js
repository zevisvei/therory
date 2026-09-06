/**
 * Persistent player profile — localStorage only, no server, no database.
 *
 * Everything the site remembers about the player lives under a single key so a
 * quota error or a corrupt value can never leave half a profile behind.
 */

const KEY = 'maslul.v1';

const DEFAULT_STATE = {
  v: 1,
  name: 'נהג/ת חדש/ה',
  xp: 0,
  games: {},
  totals: { answered: 0, correct: 0 },
  byCategory: {},
  streak: { current: 0, longest: 0, lastDay: null },
  badges: [],
  history: [],
};

const HISTORY_CAP = 60;

export const BADGES = [
  { id: 'first_drive', icon: '🚗', name: 'ההתחלה', desc: 'סיימת סיבוב ראשון' },
  { id: 'explorer',    icon: '🧭', name: 'סייר',    desc: 'שיחקת בכל המשחקים' },
  { id: 'reflex',      icon: '🐆', name: 'רפלקס חתולי', desc: 'תגובה מתחת ל-350 מ״ש' },
  { id: 'light_master',icon: '🚦', name: 'אלוף הרמזורים', desc: '1500 נקודות ברמזור מהיר' },
  { id: 'sign_reader', icon: '🚸', name: 'קורא תמרורים', desc: '20 תמרורים ברצף' },
  { id: 'priority',    icon: '🔀', name: 'זכות קדימה', desc: '10 צמתים ברצף' },
  { id: 'hawk',        icon: '🦅', name: 'עין נץ',   desc: '1200 נקודות באיתור סיכונים' },
  { id: 'physicist',   icon: '📏', name: 'פיזיקאי',  desc: '5 הערכות מרחק מדויקות' },
  { id: 'passed_test', icon: '🎓', name: 'עברת טסט!', desc: 'עברת את הסימולטור ברמת טסט' },
  { id: 'clean_sheet', icon: '✨', name: 'ללא רבב',  desc: 'סימולטור בלי ליקוי אחד' },
  { id: 'centurion',   icon: '💯', name: 'מאה',      desc: '100 שאלות שנענו' },
  { id: 'week',        icon: '🔥', name: 'שבוע רצוף', desc: '7 ימי תרגול ברצף' },
  { id: 'level10',     icon: '⭐', name: 'רמה 10',   desc: 'הגעת לרמה 10' },
];

/** Total XP required to reach a level. Level 2 at 100, 3 at 300, 4 at 600... */
function xpForLevel(level) {
  return 50 * level * (level - 1);
}

export function levelFromXp(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp && level < 99) level += 1;
  return level;
}

export function levelProgress(xp) {
  const level = levelFromXp(xp);
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const span = ceil - floor;
  return {
    level,
    into: xp - floor,
    need: span,
    pct: span > 0 ? Math.min(100, Math.round(((xp - floor) / span) * 100)) : 100,
  };
}

function todayKey(d = new Date()) {
  // Local calendar day, so a streak follows the player's own midnight.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    // Merge onto defaults so a profile written by an older build stays usable.
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      totals: { ...DEFAULT_STATE.totals, ...(parsed.totals || {}) },
      streak: { ...DEFAULT_STATE.streak, ...(parsed.streak || {}) },
      games: parsed.games || {},
      byCategory: parsed.byCategory || {},
      badges: Array.isArray(parsed.badges) ? parsed.badges : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

const state = load();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the session still works, it just forgets.
  }
  listeners.forEach((fn) => fn(state));
}

function gameSlot(id) {
  if (!state.games[id]) {
    state.games[id] = { best: 0, plays: 0, totalScore: 0, lastPlayed: null, extra: {} };
  }
  if (!state.games[id].extra) state.games[id].extra = {};
  return state.games[id];
}

/** Records that the player practised today and returns the streak length. */
function touchStreak() {
  const today = todayKey();
  const last = state.streak.lastDay;
  if (last === today) return state.streak.current;

  if (last && daysBetween(last, today) === 1) state.streak.current += 1;
  else state.streak.current = 1;

  state.streak.lastDay = today;
  state.streak.longest = Math.max(state.streak.longest, state.streak.current);
  return state.streak.current;
}

const pendingBadges = [];

/** Grants a badge once. Newly earned ids surface through `drainNewBadges()`. */
function award(id) {
  if (state.badges.includes(id)) return false;
  if (!BADGES.some((b) => b.id === id)) return false;
  state.badges.push(id);
  pendingBadges.push(BADGES.find((b) => b.id === id));
  return true;
}

function autoBadges(gameCount) {
  if (state.totals.answered >= 100) award('centurion');
  if (state.streak.current >= 7) award('week');
  if (levelFromXp(state.xp) >= 10) award('level10');
  if (Object.keys(state.games).length >= gameCount) award('explorer');
}

export const Store = {
  get state() { return state; },

  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  get level() { return levelFromXp(state.xp); },
  get progress() { return levelProgress(state.xp); },

  setName(name) {
    state.name = (name || '').trim().slice(0, 20) || DEFAULT_STATE.name;
    persist();
  },

  best(gameId) { return state.games[gameId]?.best ?? 0; },
  plays(gameId) { return state.games[gameId]?.plays ?? 0; },
  extra(gameId) { return state.games[gameId]?.extra ?? {}; },

  setExtra(gameId, patch) {
    Object.assign(gameSlot(gameId).extra, patch);
    persist();
  },

  award(id) {
    if (award(id)) persist();
  },

  /** Adds per-question accuracy without ending a run (used by the quiz games). */
  logAnswer(category, correct) {
    state.totals.answered += 1;
    if (correct) state.totals.correct += 1;
    if (category) {
      const slot = state.byCategory[category] || (state.byCategory[category] = { answered: 0, correct: 0 });
      slot.answered += 1;
      if (correct) slot.correct += 1;
    }
  },

  /**
   * Ends a run: stores the score, grants XP, refreshes the streak and returns
   * everything the result screen needs to animate.
   */
  finishRun(gameId, { score = 0, xp = 0, label = '', passed = null, gameCount = 7 } = {}) {
    const slot = gameSlot(gameId);
    const isBest = score > slot.best;

    slot.plays += 1;
    slot.totalScore += score;
    slot.best = Math.max(slot.best, score);
    slot.lastPlayed = Date.now();

    const before = levelFromXp(state.xp);
    state.xp += Math.max(0, Math.round(xp));
    const after = levelFromXp(state.xp);

    const streak = touchStreak();

    state.history.unshift({ t: Date.now(), g: gameId, s: score, l: label, p: passed });
    state.history = state.history.slice(0, HISTORY_CAP);

    award('first_drive');
    autoBadges(gameCount);
    persist();

    return {
      isBest,
      best: slot.best,
      levelUp: after > before ? after : null,
      streak,
      newBadges: this.drainNewBadges(),
      progress: levelProgress(state.xp),
    };
  },

  drainNewBadges() { return pendingBadges.splice(0, pendingBadges.length); },

  reset() {
    Object.assign(state, structuredClone(DEFAULT_STATE));
    persist();
  },
};
