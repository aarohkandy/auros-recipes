/**
 * The namespace, read from the one file that holds it.
 *
 * `auros.config.json` is the single source of truth for the organisation, the product name, the
 * registry and the base image (DECISIONS.md D1). Nothing in this toolchain writes any of those as a
 * literal, which is why renaming the company is one file plus a registry re-tag and not a grep.
 *
 * THE BOOTSTRAP, stated plainly because it is the one awkward edge. That file lives in the Auros
 * control repository, one level above a normal checkout of this one, and a person who forks only
 * this repository will not have it. Resolution order:
 *
 *   1. $AUROS_CONFIG            an explicit path, which is what CI uses.
 *   2. .auros-meta/             a checkout of the control repo placed inside this one.
 *   3. upwards from here        the ordinary local layout, where both repos sit side by side.
 *
 * If none of those finds it, the error says so in words rather than failing later with a FROM line
 * that reads `undefined`. README.md section "Rebuilding without us" has the clone command.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface AurosConfig {
  readonly org: string;
  readonly product: string;
  readonly registry: string;
  readonly baseImage: string;
  readonly baseTag: string;
  readonly repos: Readonly<Record<string, string>>;
  readonly arch: string;
  /** Where it was found. Printed in the generated Containerfile's header so the provenance is visible. */
  readonly configPath: string;
}

const FILENAME = 'auros.config.json';

export class ConfigNotFound extends Error {
  constructor(startedFrom: string) {
    super(
      `cannot find ${FILENAME}, and this toolchain will not guess at a namespace.\n\n` +
        `It holds the organisation, the registry and the base image — the values that become the\n` +
        `FROM line of every image we build. Writing them as literals here would mean a rename is a\n` +
        `grep across five repositories instead of an edit to one file, so there are no literals to\n` +
        `fall back on.\n\n` +
        `Looked for it in $AUROS_CONFIG, in .auros-meta/, and in every directory above\n` +
        `${startedFrom}.\n\n` +
        `It lives in the Auros control repository. Clone that next to this one, or point\n` +
        `$AUROS_CONFIG at the file directly. See README.md, "Rebuilding without us".`,
    );
    this.name = 'ConfigNotFound';
  }
}

export function findConfigPath(startDir: string): string {
  const fromEnv = process.env['AUROS_CONFIG'];
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new ConfigNotFound(`$AUROS_CONFIG=${fromEnv} (which does not exist)`);
    return resolve(fromEnv);
  }
  const vendored = join(startDir, '.auros-meta', FILENAME);
  if (existsSync(vendored)) return vendored;

  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigNotFound(startDir);
}

function requireString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path}: '${key}' is missing or is not a string. This file is the only place that value exists.`);
  }
  return value;
}

export function loadConfig(startDir: string = process.cwd()): AurosConfig {
  const configPath = findConfigPath(startDir);
  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`${configPath}: not a JSON object`);
  const obj = raw as Record<string, unknown>;
  const repos = (typeof obj['repos'] === 'object' && obj['repos'] !== null)
    ? (obj['repos'] as Record<string, string>)
    : {};
  return {
    org: requireString(obj, 'org', configPath),
    product: requireString(obj, 'product', configPath),
    registry: requireString(obj, 'registry', configPath),
    baseImage: requireString(obj, 'baseImage', configPath),
    baseTag: requireString(obj, 'baseTag', configPath),
    arch: requireString(obj, 'arch', configPath),
    repos,
    configPath,
  };
}

/**
 * The image name a recipe publishes to: <registry>/<org>/<product>-<name>.
 *
 * Derived, never written down. A recipe cannot influence any part of it except the last word, which
 * is its own name, because a recipe that could choose its own registry could publish somewhere we
 * do not sign.
 */
export function imageNameFor(config: AurosConfig, recipeName: string): string {
  return `${config.registry}/${config.org}/${config.product}-${recipeName}`;
}

/** The base image reference, pinned to a digest when one is known. */
export function baseReference(config: AurosConfig, digest?: string | undefined): string {
  return digest ? `${config.baseImage}@${digest}` : `${config.baseImage}:${config.baseTag}`;
}
