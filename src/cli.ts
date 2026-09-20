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
import { loadRecipe, nonCanonicalSchemaLiteral, repoRoot } from './recipe.ts';
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

/**
 * Validate one file, and return a VERDICT even when it does not parse.
 *
 * Unreadable YAML is a fact about the recipe, not about this toolchain, so it exits 1 like every
 * other refusal. It used to propagate out of loadRecipe and land in main()'s catch, which calls
 * fail() and exits 2 -- so a stranger's duplicate map key was indistinguishable, to any CI step that
 * branches on the exit code, from "our catalogue is broken". That points the operator triaging a red
 * build at the toolchain instead of at the file. Exit 2 is reserved for failures that are genuinely
 * ours: a missing schema, an unreadable catalogue, a missing auros.config.json. The file not being
 * there at all is also ours in that sense -- CI named a path that does not exist -- so it still
 * exits 2, and that is the one case separated out here by errno.
 */
function runValidate(tool: Toolchain, path: string): ValidationResult {
  let loaded;
  try {
    loaded = loadRecipe(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') throw err;
    return {
      ok: false,
      notes: [],
      refusals: [
        {
          where: '(top level)',
          what: (() => {
            const detail = (err as Error).message.replace(/^[\s\S]*? is not valid YAML\.\n?/, '').trim();
            return `This file is not valid YAML.${detail ? `\n${detail}` : ''}`;
          })(),
          why:
            'A recipe is read before it is judged, so a file YAML cannot parse is refused here ' +
            'rather than reported as a broken toolchain. Duplicate keys, a second document after ' +
            '`---`, and unbalanced quotes all land here. This is a verdict about the file: exit 1.',
        },
      ],
    };
  }
  const result = validateDocument(tool, loaded.doc, loaded.path);
  const literal = nonCanonicalSchemaLiteral(loaded.text);
  if (literal === null) return result;
  return {
    ok: false,
    notes: result.notes,
    refusals: [
      {
        where: 'schema',
        what: `The form version is written as '${literal}'. Write it as the plain number 1.`,
        why:
          'This field decides how every other line in the file is read, so it must say exactly one ' +
          'thing. 1.0, 0x1, +1 and "1" all mean 1 to a YAML parser and would mean nothing in ' +
          'particular to a person reading the file the day a second version of this form exists.',
      },
      ...result.refusals,
    ],
  };
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

  const baseDigest = resolveBaseDigest();

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
