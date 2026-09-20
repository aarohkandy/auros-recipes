/*
 * ── COORDINATION NOTE FOR AGENTS · 2026-09-20 ──────────────────────────────────────────────────────
 * Several agents edit this repository concurrently. On 2026-09-20 a WHOLESALE rewrite of
 * src/validate.ts silently reverted a real fix (the first_boot_message font-coverage check — a
 * finding that a first-boot message in a script the image has no font for renders as empty boxes to
 * the very first person who sees the machine). That fix now lives in src/scripts.ts.
 *
 *   - Edit this file SURGICALLY. Do not rewrite it wholesale. Re-read it immediately before writing.
 *   - Do not reintroduce the 11-range SCRIPT_RANGES table in validate.ts; scripts.ts supersedes it,
 *     for the reason given at the top of scripts.ts.
 *   - A green test run after a wholesale rewrite does not prove nothing was lost — the reverted fix
 *     had a test, and the rewrite removed both. Diff before you commit.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
/**
 * Which script a character belongs to -- and, more importantly, the admission that this table is
 * not all of Unicode.
 *
 * The first version of the first_boot_message check enumerated eleven scripts and asked "does the
 * message use a script the fleet's fonts do not cover?". A character outside all eleven ranges
 * matched nothing, so it contributed nothing to `used`, so `missing` was empty, so the recipe was
 * ACCEPTED. A first-boot message in Chinese, Korean, Japanese, Armenian, Georgian or Khmer, or one
 * carrying an emoji, on a fleet whose only fonts draw Latin, passed in silence -- which is precisely
 * the screen of empty boxes the rule exists to prevent, arrived at through the rule itself.
 *
 * Failing open on an unrecognised script is the wrong default for a check whose entire justification
 * is that nobody is watching this screen. So the question is inverted: every character must be
 * either NEUTRAL (whitespace, ASCII punctuation and digits, the Latin-1 and General Punctuation
 * blocks -- things every font in the image carries) or belong to a script one of the chosen
 * languages brings fonts for. Anything else is refused, whether or not this table has a name for it.
 *
 * This lives in its own module so the rule is one readable file rather than a block inside the
 * validator, and so schema/README.md section 6 can point at it by name.
 */

interface ScriptRange { readonly script: string; readonly from: number; readonly to: number }

const HAN = 'Han (Chinese/Japanese/Korean)';
const KANA = 'Japanese (kana)';
const EMOJI = 'Emoji and pictographs';

const SCRIPT_RANGES: ReadonlyArray<ScriptRange> = [
  { script: 'Latin', from: 0x0041, to: 0x005a },
  { script: 'Latin', from: 0x0061, to: 0x007a },
  { script: 'Latin', from: 0x00c0, to: 0x00d6 },
  { script: 'Latin', from: 0x00d8, to: 0x00f6 },
  { script: 'Latin', from: 0x00f8, to: 0x024f },
  { script: 'Latin', from: 0x1e00, to: 0x1eff },   // Latin Extended Additional: Vietnamese lives here
  { script: 'Greek', from: 0x0370, to: 0x03ff },
  { script: 'Greek', from: 0x1f00, to: 0x1fff },
  { script: 'Cyrillic', from: 0x0400, to: 0x052f },
  { script: 'Armenian', from: 0x0530, to: 0x058f },
  { script: 'Hebrew', from: 0x0590, to: 0x05ff },
  { script: 'Arabic', from: 0x0600, to: 0x06ff },
  { script: 'Arabic', from: 0x0750, to: 0x077f },
  { script: 'Arabic', from: 0xfb50, to: 0xfdff },
  { script: 'Arabic', from: 0xfe70, to: 0xfefe },
  { script: 'Syriac', from: 0x0700, to: 0x074f },
  { script: 'Thaana', from: 0x0780, to: 0x07bf },
  { script: 'Devanagari', from: 0x0900, to: 0x097f },
  { script: 'Devanagari', from: 0xa8e0, to: 0xa8ff },
  { script: 'Bengali', from: 0x0980, to: 0x09ff },
  { script: 'Gurmukhi', from: 0x0a00, to: 0x0a7f },
  { script: 'Gujarati', from: 0x0a80, to: 0x0aff },
  { script: 'Oriya', from: 0x0b00, to: 0x0b7f },
  { script: 'Tamil', from: 0x0b80, to: 0x0bff },
  { script: 'Telugu', from: 0x0c00, to: 0x0c7f },
  { script: 'Kannada', from: 0x0c80, to: 0x0cff },
  { script: 'Malayalam', from: 0x0d00, to: 0x0d7f },
  { script: 'Sinhala', from: 0x0d80, to: 0x0dff },
  { script: 'Thai', from: 0x0e00, to: 0x0e7f },
  { script: 'Lao', from: 0x0e80, to: 0x0eff },
  { script: 'Tibetan', from: 0x0f00, to: 0x0fff },
  { script: 'Myanmar', from: 0x1000, to: 0x109f },
  { script: 'Georgian', from: 0x10a0, to: 0x10ff },
  { script: 'Georgian', from: 0x1c90, to: 0x1cbf },
  { script: 'Hangul', from: 0x1100, to: 0x11ff },
  { script: 'Ethiopic', from: 0x1200, to: 0x139f },
  { script: 'Cherokee', from: 0x13a0, to: 0x13ff },
  { script: 'Khmer', from: 0x1780, to: 0x17ff },
  { script: 'Mongolian', from: 0x1800, to: 0x18af },
  { script: EMOJI, from: 0x2190, to: 0x2bff },
  { script: HAN, from: 0x2e80, to: 0x2fdf },
  { script: HAN, from: 0x3000, to: 0x303f },
  { script: KANA, from: 0x3040, to: 0x30ff },
  { script: 'Hangul', from: 0x3130, to: 0x318f },
  { script: KANA, from: 0x31f0, to: 0x31ff },
  { script: HAN, from: 0x3400, to: 0x4dbf },
  { script: HAN, from: 0x4e00, to: 0x9fff },
  { script: 'Hangul', from: 0xa960, to: 0xa97f },
  { script: 'Hangul', from: 0xac00, to: 0xd7ff },
  { script: HAN, from: 0xf900, to: 0xfaff },
  { script: EMOJI, from: 0xfe00, to: 0xfe0f },
  { script: HAN, from: 0xff00, to: 0xffef },
  { script: EMOJI, from: 0x1f000, to: 0x1faff },
];

/**
 * Characters every font in every image can draw, so they belong to no script and need no coverage:
 * ASCII whitespace, punctuation and digits, the Latin-1 punctuation and symbol range, General
 * Punctuation (curly quotes, dashes, ellipsis), and the byte-order mark.
 */
function isNeutral(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  if (cp >= 0x20 && cp <= 0x40) return true;         // space ! " # ... 0-9 : ; < = > ? @
  if (cp >= 0x5b && cp <= 0x60) return true;         // [ \ ] ^ _ `
  if (cp >= 0x7b && cp <= 0x7e) return true;         // { | } ~
  if (cp >= 0x00a0 && cp <= 0x00bf) return true;     // NBSP and Latin-1 punctuation/symbols
  if (cp === 0x00d7 || cp === 0x00f7) return true;   // multiplication and division signs
  if (cp >= 0x2000 && cp <= 0x206f) return true;     // General Punctuation
  if (cp === 0xfeff) return true;                    // BOM
  return false;
}

function scriptOf(cp: number): string | null {
  for (const r of SCRIPT_RANGES) if (cp >= r.from && cp <= r.to) return r.script;
  return null;
}

/** Every named script the text uses, in first-appearance order. */
export function scriptsUsedIn(text: string): string[] {
  const out: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isNeutral(cp)) continue;
    const s = scriptOf(cp);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export interface ScriptAudit {
  /** Named scripts the text uses that the fleet's fonts do not cover. */
  readonly missing: string[];
  /** Characters belonging to no script this table names, as `U+XXXX 'c'` samples (at most six). */
  readonly unnamed: string[];
}

/**
 * The inverted check. `covered` is the union of the scripts of every chosen language, as
 * catalogue/languages.tsv names them.
 *
 * A named script that is not covered is refused BY NAME. A character this table cannot name is also
 * refused -- as a code point, so the refusal is actionable -- because a rule that asks "is this one
 * of the scripts I know about?" answers "no" for the entire rest of Unicode and then does nothing.
 */
export function auditScripts(text: string, covered: ReadonlySet<string>): ScriptAudit {
  const missing: string[] = [];
  const unnamed: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isNeutral(cp)) continue;
    const s = scriptOf(cp);
    if (s === null) {
      const sample = `U+${cp.toString(16).toUpperCase().padStart(4, '0')} '${ch}'`;
      if (!unnamed.includes(sample) && unnamed.length < 6) unnamed.push(sample);
      continue;
    }
    if (!covered.has(s) && !missing.includes(s)) missing.push(s);
  }
  return { missing, unnamed };
}

/** The refusal sentence for an audit that found something, or null when it found nothing. */
export function scriptRefusalText(audit: ScriptAudit, list: (items: string[]) => string): string | null {
  const { missing, unnamed } = audit;
  if (missing.length === 0 && unnamed.length === 0) return null;
  const chars = unnamed.length === 1 ? 'a character' : 'characters';
  if (missing.length > 0 && unnamed.length > 0) {
    return `This sentence is written in ${list(missing)}, which no language on this fleet brings fonts for, and it also contains ${chars} in a script this toolchain has no name for (${unnamed.join(', ')}).`;
  }
  if (missing.length > 0) {
    return `This sentence is written in ${list(missing)}, and none of the languages on this fleet brings the fonts for that.`;
  }
  return `This sentence contains ${chars} in a script this toolchain has no name for, so no language can be said to cover it (${unnamed.join(', ')}).`;
}

export const SCRIPT_REFUSAL_WHY =
  'The first sentence a stranger reads is the one place a missing font is guaranteed to be seen, ' +
  'and it is the one place nobody is watching. Every character here must either be punctuation ' +
  'every font carries or belong to a script one of the chosen languages installs fonts for -- ' +
  'including emoji, which are a font like any other and are not in this image. Either add the ' +
  'language to other_languages, which brings its fonts, or write the message in a script this ' +
  'fleet can already draw. This check refuses what it cannot name rather than ignoring it: the ' +
  'earlier version knew eleven scripts and accepted Chinese, Korean, Japanese, Armenian, Georgian ' +
  'and Khmer in silence.';
