/**
 * The shape of a recipe, as TypeScript sees it, plus loading and locating.
 *
 * These interfaces are a convenience for the compiler, NOT the rules. recipe.schema.json is the
 * rules. A field added here and not there is a field nothing checks, and a field nothing checks is
 * decoration — see schema/README.md section 7.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export type Policy = 'open' | 'managed' | 'locked' | 'kiosk';

export interface Recipe {
  schema: 1;
  name: string;
  for: string;
  organisation: {
    display_name: string;
    helpdesk: { label: string; phone: string };
    logo?: string;
  };
  hardware: { machines: number; models: string[]; also_test?: string[] };
  language: string;
  other_languages?: string[];
  keyboard: string;
  second_script?: string;
  switch_scripts_with?: string;
  timezone: string;
  apps: string[];
  prune: {
    keep_only_the_apps_above: boolean;
    also_keep?: string[];
    also_remove?: string[];
    must_remove_at_least: number;
  };
  policy: Policy;
  desktop?: {
    taskbar_and_start_menu?: boolean;
    explorer_like_file_manager?: boolean;
    familiar_folder_names?: boolean;
    double_click_to_open?: boolean;
    guided_first_boot?: boolean;
    can_install_apps?: boolean;
    can_reach_a_terminal?: boolean;
  };
  kiosk?: {
    opens: string;
    allowed_sites: string[];
    printing?: boolean;
    usb_storage?: boolean;
    forget_session_after_minutes: number;
    restart_daily_at?: string;
  };
  windows_apps?: {
    enabled: boolean;
    we_promise_nothing_else?: true;
    tested?: Array<{ app: string; date: string; result: string; note?: string }>;
  };
  theme?: { preset?: string; accent?: string; text_scale?: number; cursor_size?: string };
  updates?: { install_between?: string };
  first_boot_message?: string;
  size_budget_gb: number;
  approved_by: { enrolment: string; name: string; role: string; date: string };
}

/**
 * Defaults, stated once.
 *
 * D4 binds us to a Windows-shaped desktop SHIPPED SYSTEM-WIDE rather than left to the user, so the
 * familiar answer is what an omitted field means. `can_install_apps` and `can_reach_a_terminal`
 * default to false in the other direction: a capability nobody asked for should not appear because
 * a field was left out.
 */
export const DESKTOP_DEFAULTS = {
  taskbar_and_start_menu: true,
  explorer_like_file_manager: true,
  familiar_folder_names: true,
  double_click_to_open: true,
  guided_first_boot: true,
  can_install_apps: false,
  can_reach_a_terminal: false,
} as const;

export type DesktopSettings = { -readonly [K in keyof typeof DESKTOP_DEFAULTS]: boolean };

export function desktopSettings(recipe: Recipe): DesktopSettings {
  const declared = recipe.desktop ?? {};
  const out = { ...DESKTOP_DEFAULTS } as DesktopSettings;
  for (const key of Object.keys(DESKTOP_DEFAULTS) as Array<keyof DesktopSettings>) {
    const value = declared[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export interface LoadedRecipe {
  /** Absolute path to the recipe.yaml. */
  readonly path: string;
  /** Whatever the YAML parsed to — NOT yet known to be a recipe. */
  readonly doc: unknown;
  readonly text: string;
}

export function loadRecipe(path: string): LoadedRecipe {
  const abs = resolve(path);
  const text = readFileSync(abs, 'utf8');
  let doc: unknown;
  try {
    doc = parseYaml(text, { strict: true });
  } catch (err) {
    throw new Error(`${abs} is not valid YAML.\n  ${(err as Error).message}`);
  }
  return { path: abs, doc, text };
}

/** The repository root: the directory holding schema/ and customers/. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'schema', 'recipe.schema.json')) && existsSync(join(dir, 'catalogue', 'apps.tsv'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('cannot locate the repository root (looked for schema/recipe.schema.json and catalogue/apps.tsv above this file)');
    dir = parent;
  }
}
