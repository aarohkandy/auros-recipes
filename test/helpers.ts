/**
 * Shared fixtures. Deliberately thin: a test that needs three helpers to state what it asserts is a
 * test nobody will read when it goes red at eight in the morning.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadToolchain, validateDocument, type Toolchain, type ValidationResult } from '../src/validate.ts';
import { repoRoot } from '../src/recipe.ts';

export const ROOT = repoRoot();
export const SCHOOL_PATH = join(ROOT, 'customers', 'example-school', 'recipe.yaml');
export const KIOSK_PATH = join(ROOT, 'customers', 'example-kiosk', 'recipe.yaml');
export const WORKSTATION_PATH = join(ROOT, 'customers', 'example-workstation', 'recipe.yaml');

let cached: Toolchain | undefined;
export function toolchain(): Toolchain {
  cached ??= loadToolchain(ROOT);
  return cached;
}

export type Doc = Record<string, unknown>;

export function read(path: string): Doc {
  return parseYaml(readFileSync(path, 'utf8')) as Doc;
}

export const school = (): Doc => read(SCHOOL_PATH);
export const kiosk = (): Doc => read(KIOSK_PATH);
export const workstation = (): Doc => read(WORKSTATION_PATH);

/** Deep-copy a fixture and apply one mutation, so a table entry is one readable line. */
export function mutate(base: Doc, fn: (doc: Doc) => void): Doc {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
}

export function check(doc: Doc, path = SCHOOL_PATH): ValidationResult {
  return validateDocument(toolchain(), doc, path);
}

/** Everything a refusal said, flattened, so a test can assert on the sentence and not the shape. */
export function said(result: ValidationResult): string {
  return result.refusals.map((r) => `${r.where} | ${r.what} | ${r.why}`).join('\n');
}
