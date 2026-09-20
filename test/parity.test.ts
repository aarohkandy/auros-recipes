/**
 * Two validators, one set of rules.
 *
 * schema/README.md section 1 makes a promise the whole company rests on: "if we disappear, you
 * validate and rebuild your own operating system with tools you already have, and you get the same
 * answers we would have given you."
 *
 * That is only true if the rules live in a data file rather than in a program. This repository ships
 * two independent readers of that file -- Python + jsonschema, which is what the README tells a
 * customer to install, and TypeScript + ajv, which is what our CI runs -- and this test asserts they
 * return the same verdict on every case in the refusal table.
 *
 * If they ever disagree, one of two things has happened and both matter: recipe.schema.json has
 * drifted into something that depends on a validator's quirks, or one of the two validators knows a
 * rule the file does not carry. The second is the one that would quietly make us unreplaceable.
 *
 * When Python or jsonschema is not installed this test SKIPS AND SAYS SO. A skipped test is not a
 * passing test, and CI installs both so that it runs there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { compileSchema, schemaRefusals } from '../src/schema.ts';
import { ROOT, school, kiosk, workstation, mutate, type Doc } from './helpers.ts';

const compiled = compileSchema(ROOT);

function pythonAvailable(): boolean {
  const probe = spawnSync('python3', ['-c', 'import jsonschema, yaml'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** Ask Python whether each document is valid, in one process. */
function pythonVerdicts(docs: ReadonlyArray<unknown>): boolean[] {
  const script = `
import json, sys, pathlib
from jsonschema import Draft202012Validator, FormatChecker
schema = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
Draft202012Validator.check_schema(schema)
v = Draft202012Validator(schema, format_checker=FormatChecker())
docs = json.load(sys.stdin)
print(json.dumps([len(list(v.iter_errors(d))) == 0 for d in docs]))
`;
  const run = spawnSync('python3', ['-c', script, join(ROOT, 'schema', 'recipe.schema.json')], {
    input: JSON.stringify(docs),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `python validator failed:\n${run.stderr}`);
  return JSON.parse(run.stdout) as boolean[];
}

const S = school();
const K = kiosk();
const W = workstation();

/** A cross-section of the refusal table, plus the three recipes that must be accepted. */
const CASES: ReadonlyArray<{ label: string; doc: Doc; acceptable: boolean }> = [
  { label: 'example-school', doc: S, acceptable: true },
  { label: 'example-kiosk', doc: K, acceptable: true },
  { label: 'example-workstation', doc: W, acceptable: true },
  { label: 'a FROM override', doc: mutate(S, (d) => { d['from'] = 'ghcr.io/x/y'; }), acceptable: false },
  { label: 'a base digest', doc: mutate(S, (d) => { d['digest'] = 'sha256:aa'; }), acceptable: false },
  { label: 'a kernel pin', doc: mutate(S, (d) => { d['kernel'] = '6.1'; }), acceptable: false },
  { label: 'a version hold', doc: mutate(S, (d) => { d['hold'] = ['firefox']; }), acceptable: false },
  { label: 'a pin spelled as an app', doc: mutate(S, (d) => { (d['apps'] as string[]).push('firefox-140.0'); }), acceptable: false },
  { label: 'a raw Flatpak ref', doc: mutate(S, (d) => { (d['apps'] as string[]).push('org.mozilla.firefox'); }), acceptable: false },
  { label: 'pruning bootc', doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('bootc'); }), acceptable: false },
  { label: 'pruning a screen reader', doc: mutate(S, (d) => { ((d['prune'] as Doc)['also_remove'] as string[]).push('screen reader'); }), acceptable: false },
  { label: 'a post-install script', doc: mutate(S, (d) => { d['post_install'] = 'curl x | sh'; }), acceptable: false },
  { label: 'skipping the checks', doc: mutate(S, (d) => { d['skip_checks'] = true; }), acceptable: false },
  { label: 'a wifi password', doc: mutate(S, (d) => { d['wifi_password'] = 'hunter2'; }), acceptable: false },
  { label: 'a testimonial', doc: mutate(S, (d) => { d['testimonial'] = 'great'; }), acceptable: false },
  { label: 'a non-Latin primary keyboard', doc: mutate(S, (d) => { d['keyboard'] = 'Marathi (InScript)'; }), acceptable: false },
  { label: 'a second script with no toggle', doc: mutate(S, (d) => { delete d['switch_scripts_with']; }), acceptable: false },
  { label: 'a terminal on a managed fleet', doc: mutate(S, (d) => { d['desktop'] = { can_reach_a_terminal: true }; }), acceptable: false },
  { label: 'a locked fleet that installs apps', doc: mutate(S, (d) => { d['policy'] = 'locked'; d['desktop'] = { can_install_apps: true }; }), acceptable: false },
  { label: 'a kiosk with a desktop block', doc: mutate(K, (d) => { d['desktop'] = { taskbar_and_start_menu: true }; }), acceptable: false },
  { label: 'a kiosk running Windows programs', doc: mutate(K, (d) => { d['windows_apps'] = { enabled: true, we_promise_nothing_else: true }; }), acceptable: false },
  { label: 'a kiosk over plain http', doc: mutate(K, (d) => { (d['kiosk'] as Doc)['opens'] = 'http://a.example.org/'; }), acceptable: false },
  { label: 'a kiosk allowed to reach nothing', doc: mutate(K, (d) => { (d['kiosk'] as Doc)['allowed_sites'] = []; }), acceptable: false },
  { label: 'an unknown top-level key', doc: mutate(S, (d) => { d['notes'] = 'anything'; }), acceptable: false },
  { label: 'a typo in a subtraction key', doc: mutate(S, (d) => { (d['prune'] as Doc)['also_remvoe'] = ['games']; }), acceptable: false },
  { label: 'a removal floor of zero', doc: mutate(S, (d) => { (d['prune'] as Doc)['must_remove_at_least'] = 0; }), acceptable: false },
  { label: 'a direction override in a name', doc: mutate(S, (d) => { (d['organisation'] as Doc)['display_name'] = 'Example‮Vidyalaya'; }), acceptable: false },
  { label: 'an unknown schema version', doc: mutate(S, (d) => { d['schema'] = 2; }), acceptable: false },
];

test('ajv and jsonschema return the same verdict on every case', { skip: pythonAvailable() ? false : 'python3 with jsonschema and pyyaml is not installed here. CI installs both; this claim is unverified on this machine.' }, () => {
  const fromPython = pythonVerdicts(CASES.map((c) => c.doc));
  const disagreements: string[] = [];
  CASES.forEach((entry, i) => {
    const fromAjv = schemaRefusals(compiled, entry.doc).length === 0;
    if (fromAjv !== fromPython[i]) {
      disagreements.push(`${entry.label}: ajv says ${fromAjv ? 'valid' : 'invalid'}, jsonschema says ${fromPython[i] ? 'valid' : 'invalid'}`);
    }
    if (fromAjv !== entry.acceptable) {
      disagreements.push(`${entry.label}: expected ${entry.acceptable ? 'valid' : 'invalid'}, ajv says ${fromAjv ? 'valid' : 'invalid'}`);
    }
  });
  assert.deepEqual(
    disagreements,
    [],
    'The two validators disagree, which means either the schema has drifted into depending on one ' +
      "validator's behaviour, or one of them knows a rule the file does not carry. The second would " +
      'quietly make us unreplaceable, which is the one thing schema/README.md section 1 promises we ' +
      'are not.',
  );
});

test("the published refusal suite still passes, because section 6 tells customers to run it", { skip: pythonAvailable() ? false : 'python3 with jsonschema and pyyaml is not installed here.' }, () => {
  const run = spawnSync('python3', [join(ROOT, 'schema', 'refusals.test.py')], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, `schema/refusals.test.py failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /OK$/m);
});

test('the command schema/README.md section 6 gives a customer actually works', { skip: pythonAvailable() ? false : 'python3 with jsonschema and pyyaml is not installed here.' }, () => {
  const run = spawnSync('python3', [join(ROOT, 'schema', 'validate.py'), '--all'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, `schema/validate.py --all failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /all recipes pass/);
});
