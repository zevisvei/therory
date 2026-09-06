/**
 * Loads the static question bank exported by scripts/export_web.py.
 *
 * Paths are resolved against this module's own URL so the site works both at a
 * domain root and under a GitHub Pages project path such as /therory/.
 */

import { shuffle } from './ui.js';

const DATA_URL = new URL('../../data/questions.json', import.meta.url);
const META_URL = new URL('../../data/meta.json', import.meta.url);
const IMG_BASE = new URL('../../data/img/', import.meta.url);

export const CATEGORY_LABELS = {
  laws: 'חוקי התנועה',
  signs: 'תמרורים',
  safety: 'בטיחות',
  vehicle: 'הכרת הרכב',
};

let cache = null;
let inflight = null;

/** Fetches (once) and caches the whole bank. */
export async function loadBank() {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const [questions, meta] = await Promise.all([
      fetch(DATA_URL).then((r) => {
        if (!r.ok) throw new Error(`questions.json: ${r.status}`);
        return r.json();
      }),
      fetch(META_URL).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);

    cache = {
      questions,
      meta,
      byCategory: questions.reduce((acc, q) => {
        (acc[q.c] ||= []).push(q);
        return acc;
      }, {}),
    };
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function imageUrl(questionId) {
  return new URL(`${questionId}.webp`, IMG_BASE).href;
}

/**
 * Filters the bank.
 * @param {object} opts
 * @param {string[]} [opts.categories] category codes to keep
 * @param {string}   [opts.licence]    licence code the question must apply to
 * @param {boolean}  [opts.withImage]  require (true) or forbid (false) an image
 * @param {RegExp}   [opts.match]      pattern the question text must match
 * @param {number}   [opts.limit]      cap after shuffling
 */
export function filterQuestions(bank, opts = {}) {
  const { categories, licence, withImage, match, limit } = opts;
  let out = bank.questions;

  if (categories?.length) out = out.filter((q) => categories.includes(q.c));
  if (licence) out = out.filter((q) => q.y.includes(licence));
  if (withImage === true) out = out.filter((q) => q.g);
  if (withImage === false) out = out.filter((q) => !q.g);
  if (match) out = out.filter((q) => match.test(q.t));

  out = shuffle(out);
  return limit ? out.slice(0, limit) : out;
}

/**
 * Presents a question with its options shuffled, keeping track of which
 * shuffled index is the correct one.
 */
export function presentQuestion(q) {
  const order = shuffle(q.o.map((text, i) => ({ text, i })));
  return {
    id: q.i,
    text: q.t,
    category: q.c,
    image: q.g ? imageUrl(q.i) : null,
    options: order.map((o) => o.text),
    answer: order.findIndex((o) => o.i === q.a),
  };
}

/** Licence codes present in the bank, ordered for display. */
export const LICENCES = [
  { id: 'B', label: 'B · רכב פרטי' },
  { id: 'A', label: 'A · אופנוע' },
  { id: 'C1', label: 'C1 · מסחרי עד 12 טון' },
  { id: 'C', label: 'C · משאית' },
  { id: 'D', label: 'D · אוטובוס' },
  { id: '1', label: '1 · טרקטור' },
];
