#!/usr/bin/env node
/**
 * auros-recipe -- validate, compile, explain.
 *
 * Three verbs and no flags that weaken anything. There is no --force, no --skip-checks and no
 * --allow-unsigned, for the same reason recipe.schema.json has no field for them: a flag that skips
 * a check is a flag somebody uses once, at the end of a long day, for a good reason, and then the
 * check is advisory forever.
 *
 * Exit codes are what CI reads: 0 means the recipe is acceptable, 1 means it was refused, 2 means
 * this tool could not do its job (a missing file, a broken catalogue). The middle one is a verdict;
 * the last one is not, and conflating them would let a broken toolchain look like a clean run.
 */

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { compile, resolveBaseDigest } from './compile.ts';
import { explain } from './explain.ts';
import { loadRecipe, repoRoot } from './recipe.ts';
import { formatRefusals } from './refusal.ts';
import { loadToolchain, validateDocument, type Toolchain, type ValidationResult } from './validate.ts';

const USAGE = `auros-recipe -- the recipe toolchain

  auros-recipe validate <path/to/recipe.yaml> [more...]   is this recipe acceptable?
  auros-recipe compile  <path/to/recipe.yaml>             recipe.yaml -> Containerfile, on stdout
  auros-recipe explain  <path/to/recipe.yaml>             what this recipe produces, in English

  --all                 with validate: every recipe under customers/
  -o, --out <file>      with compile: write there instead of stdout

Exit codes: 0 acceptable, 1 refused, 2 this tool could not run.

There is deliberately no flag that skips a check, forces a publish, or accepts an untested image.
An unsigned or untested image can never reach a customer, and the strongest way to write that rule
is a program that cannot express the request.
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function runValidate(tool: Toolchain, path: string): ValidationResult {
  const loaded = loadRecipe(path);
  return validateDocument(tool, loaded.doc, loaded.path);
}

function report(path: string, root: string, result: ValidationResult): void {
  const shown = relative(root, resolve(path)) || path;
  process.stdout.write(`\n${shown}\n`);
  for (const note of result.notes) process.stdout.write(`  note     ${note}\n`);
  if (result.ok) {
    process.stdout.write('  ACCEPTED\n');
    return;
  }
  process.stdout.write(formatRefusals(result.refusals));
}

function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(USAGE);
    return verb ? 0 : 2;
  }

  const root = repoRoot();
  const paths: string[] = [];
  let all = false;
  let outFile: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--all') { all = true; continue; }
    if (arg === '-o' || arg === '--out') { outFile = rest[++i]; continue; }
    if (arg.startsWith('-')) fail(`unknown option '${arg}'. There is no flag that skips a check.\n\n${USAGE}`);
    paths.push(arg);
  }

  let tool: Toolchain;
  try {
    tool = loadToolchain(root);
  } catch (err) {
    return fail(`the toolchain itself could not start: ${(err as Error).message}`);
  }

  if (verb === 'validate') {
    const targets = all || paths.length === 0 ? listRecipes(root) : paths;
    if (targets.length === 0) return fail('nothing to validate');
    let refusedCount = 0;
    for (const path of targets) {
      let result: ValidationResult;
      try {
        result = runValidate(tool, path);
      } catch (err) {
        return fail(`${path}: ${(err as Error).message}`);
      }
      report(path, root, result);
      if (!result.ok) refusedCount++;
    }
    process.stdout.write(
      refusedCount === 0
        ? `\n${targets.length} recipe${targets.length === 1 ? '' : 's'} accepted\n`
        : `\n${refusedCount} of ${targets.length} refused\n`,
    );
    return refusedCount === 0 ? 0 : 1;
  }

  if (verb !== 'compile' && verb !== 'explain') {
    process.stderr.write(`unknown command '${verb}'\n\n${USAGE}`);
    return 2;
  }

  const path = paths[0];
  if (!path) return fail(`${verb} needs exactly one recipe\n\n${USAGE}`);

  let result: ValidationResult;
  try {
    result = runValidate(tool, path);
  } catch (err) {
    return fail(`${path}: ${(err as Error).message}`);
  }
  if (!result.ok || !result.recipe || !result.plan) {
    // compile and explain both refuse to run on a recipe validate would refuse. A compiler that
    // compiles what the validator rejects is the hole every one of these rules would fall through.
    process.stderr.write(`\n${relative(root, resolve(path)) || path}\n`);
    process.stderr.write(formatRefusals(result.refusals));
    process.stderr.write(`refused: ${verb} does not run on a recipe validate would not accept.\n`);
    return 1;
  }

  const config = (() => {
    try {
      return loadConfig(root);
    } catch (err) {
      return fail((err as Error).message);
    }
  })();

  const baseDigest = resolveBaseDigest(resolve(path));

  if (verb === 'explain') {
    process.stdout.write(
      explain({
        recipe: result.recipe,
        plan: result.plan,
        catalogue: tool.catalogue,
        config,
        fonts: result.fonts ?? [],
        baseDigest,
        notes: result.notes,
      }),
    );
    return 0;
  }

  let text: string;
  try {
    text = compile({
      recipe: result.recipe,
      recipePath: resolve(path),
      plan: result.plan,
      fonts: result.fonts ?? [],
      config,
      catalogue: tool.catalogue,
      baseDigest,
      notes: result.notes,
    });
  } catch (err) {
    return fail(`compile stopped: ${(err as Error).message}`);
  }
  if (outFile) writeFileSync(outFile, text, 'utf8');
  else process.stdout.write(text);
  return 0;
}

function listRecipes(root: string): string[] {
  const dir = resolve(root, 'customers');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((entry) => resolve(dir, entry, 'recipe.yaml'))
    .filter((p) => existsSync(p));
}

process.exit(main(process.argv.slice(2)));
