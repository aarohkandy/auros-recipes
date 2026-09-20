/**
 * The catalogue: how a human name becomes a package.
 *
 * Loaded from catalogue/*.tsv. See catalogue/README.md for why the data is here rather than inside
 * the base image, and what changes when the base grows one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Kind = 'rpm' | 'flatpak';

export interface AppEntry {
  readonly name: string;
  readonly kind: Kind;
  readonly ref: string;
  /** The removable group this app belongs to, or null. */
  readonly group: string | null;
  /** `terminal` or `installs-software` — a door the policy modes care about — or null. */
  readonly capability: 'terminal' | 'installs-software' | null;
}

export interface GroupMember {
  readonly kind: Kind;
  readonly ref: string;
}

export interface LanguageEntry {
  readonly language: string;
  readonly locale: string;
  readonly scripts: ReadonlyArray<string>;
  /** Empty means: we know this language and we have no font package for it. That is a gap, not a typo. */
  readonly fonts: ReadonlyArray<string>;
}

export interface LayoutEntry {
  readonly name: string;
  readonly xkb: string;
  readonly script: string;
}

export interface ProtectedEntry {
  readonly pkg: string;
  readonly role: string;
  readonly why: string;
}

export interface Catalogue {
  readonly apps: ReadonlyMap<string, AppEntry>;
  readonly groups: ReadonlyMap<string, ReadonlyArray<GroupMember>>;
  readonly languages: ReadonlyMap<string, LanguageEntry>;
  readonly layouts: ReadonlyMap<string, LayoutEntry>;
  readonly toggles: ReadonlyMap<string, string>;
  readonly protectedSet: ReadonlyMap<string, ProtectedEntry>;
  readonly source: string;
}

/** Rows of a tab-separated file, comments and blank lines dropped, header row consumed. */
export function readTsv(path: string): string[][] {
  const text = readFileSync(path, 'utf8');
  const rows: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) continue;
    rows.push(line.split('\t').map((c) => c.trim()));
  }
  if (rows.length === 0) throw new Error(`${path}: no rows at all — a catalogue file that is empty is a catalogue that refuses everything`);
  return rows.slice(1);
}

function cell(row: string[], index: number, path: string, line: number): string {
  const value = row[index];
  if (value === undefined) throw new Error(`${path}: row ${line} has ${row.length} columns, fewer than expected`);
  return value;
}

function list(value: string): string[] {
  if (value === '-' || value === '') return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadCatalogue(dir: string): Catalogue {
  const apps = new Map<string, AppEntry>();
  readTsv(join(dir, 'apps.tsv')).forEach((row, i) => {
    const name = cell(row, 0, 'apps.tsv', i);
    const kind = cell(row, 1, 'apps.tsv', i);
    if (kind !== 'rpm' && kind !== 'flatpak') throw new Error(`apps.tsv: '${name}' has kind '${kind}', which is neither rpm nor flatpak`);
    const group = cell(row, 3, 'apps.tsv', i);
    const capability = cell(row, 4, 'apps.tsv', i);
    if (capability !== '-' && capability !== 'terminal' && capability !== 'installs-software') {
      throw new Error(`apps.tsv: '${name}' has capability '${capability}', which is not one this toolchain knows how to enforce`);
    }
    if (apps.has(name)) throw new Error(`apps.tsv: '${name}' appears twice — two rows for one name means the reader cannot tell which package they get`);
    apps.set(name, {
      name,
      kind,
      ref: cell(row, 2, 'apps.tsv', i),
      group: group === '-' ? null : group,
      capability: capability === '-' ? null : capability,
    });
  });

  const groups = new Map<string, GroupMember[]>();
  readTsv(join(dir, 'groups.tsv')).forEach((row, i) => {
    const group = cell(row, 0, 'groups.tsv', i);
    const kind = cell(row, 1, 'groups.tsv', i);
    if (kind !== 'rpm' && kind !== 'flatpak') throw new Error(`groups.tsv: '${group}' has kind '${kind}'`);
    const members = groups.get(group) ?? [];
    members.push({ kind, ref: cell(row, 2, 'groups.tsv', i) });
    groups.set(group, members);
  });

  const languages = new Map<string, LanguageEntry>();
  readTsv(join(dir, 'languages.tsv')).forEach((row, i) => {
    const language = cell(row, 0, 'languages.tsv', i);
    languages.set(language, {
      language,
      locale: cell(row, 1, 'languages.tsv', i),
      scripts: list(cell(row, 2, 'languages.tsv', i)),
      fonts: list(cell(row, 3, 'languages.tsv', i)),
    });
  });

  const layouts = new Map<string, LayoutEntry>();
  const toggles = new Map<string, string>();
  readTsv(join(dir, 'keyboards.tsv')).forEach((row, i) => {
    const kind = cell(row, 0, 'keyboards.tsv', i);
    const name = cell(row, 1, 'keyboards.tsv', i);
    const xkb = cell(row, 2, 'keyboards.tsv', i);
    if (kind === 'layout') layouts.set(name, { name, xkb, script: cell(row, 3, 'keyboards.tsv', i) });
    else if (kind === 'toggle') toggles.set(name, xkb);
    else throw new Error(`keyboards.tsv: row ${i} has kind '${kind}', which is neither layout nor toggle`);
  });

  const protectedSet = new Map<string, ProtectedEntry>();
  readTsv(join(dir, 'protected.tsv')).forEach((row, i) => {
    const pkg = cell(row, 0, 'protected.tsv', i);
    protectedSet.set(pkg, { pkg, role: cell(row, 1, 'protected.tsv', i), why: cell(row, 2, 'protected.tsv', i) });
  });

  return { apps, groups, languages, layouts, toggles, protectedSet, source: dir };
}
