/**
 * A refusal, and the vocabulary for writing one.
 *
 * Every rejection this toolchain produces is addressed to a person who is trying to get some
 * laptops working, not to a parser. It says where the problem is, what the rule is, and — the part
 * that matters most — why the rule existing is the thing they are buying rather than an obstacle
 * between them and it.
 *
 * That is not politeness. A refusal a reader does not understand gets worked around, and every
 * workaround for these particular rules ends in the same place: a fleet that stops receiving
 * repairs while still looking maintained.
 */

export interface Refusal {
  /** Where in the recipe, in dotted form: `prune.also_remove[2]`. `(top level)` when nowhere. */
  readonly where: string;
  /** One line. What is wrong. */
  readonly what: string;
  /** One paragraph. Why refusing is the feature. May be empty for a plain shape error. */
  readonly why: string;
}

export function refuse(where: string, what: string, why = ''): Refusal {
  return { where, what, why };
}

/** `prune.also_remove[2]` from `['prune','also_remove',2]`. */
export function pointer(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '(top level)';
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out === '' ? part : `.${part}`;
  }
  return out;
}

/** The whole set of refusals, wrapped so a caller can throw one thing. */
export class RecipeRefused extends Error {
  readonly refusals: ReadonlyArray<Refusal>;
  constructor(refusals: ReadonlyArray<Refusal>, subject: string) {
    super(`${subject}: ${refusals.length} refusal${refusals.length === 1 ? '' : 's'}`);
    this.name = 'RecipeRefused';
    this.refusals = refusals;
  }
}

const WIDTH = 96;

/** Wrap a paragraph to a readable column, indenting continuation lines. */
export function wrap(text: string, indent: string): string {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line === '') line = word;
      else if (line.length + 1 + word.length <= WIDTH - indent.length) line += ` ${word}`;
      else { out.push(indent + line); line = word; }
    }
    out.push(indent + line);
  }
  return out.join('\n');
}

export function formatRefusals(refusals: ReadonlyArray<Refusal>): string {
  const out: string[] = [];
  for (const r of refusals) {
    out.push(`  REFUSED  ${r.where}`);
    out.push(wrap(r.what, '           '));
    if (r.why) { out.push(''); out.push(wrap(r.why, '           ')); }
    out.push('');
  }
  return out.join('\n');
}

/**
 * Nearest matches from a closed list, for a value that missed it.
 *
 * A typo should cost seconds, not an afternoon. This is deliberately generous: it would rather
 * offer a wrong suggestion than none, because the alternative is a reader scrolling a schema.
 */
export function nearest(value: string, choices: Iterable<string>, limit = 3): string[] {
  const needle = value.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const choice of choices) {
    const score = similarity(needle, choice.toLowerCase());
    if (score >= 0.55) scored.push({ name: choice, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/** 1 - normalised Levenshtein distance. Small strings only; this is never in a hot path. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = row;
  }
  const distance = prev[b.length]!;
  return 1 - distance / Math.max(a.length, b.length);
}

/** `a, b and c` — a list a person reads rather than a JSON array. */
export function sentenceList(items: ReadonlyArray<string>): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
}
