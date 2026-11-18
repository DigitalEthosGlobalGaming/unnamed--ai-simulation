/**
 * Export a stored prompt template version in the repo's template format (packages/mind/templates/<id>.json).
 *
 *   npm run prompts:export -- --template plan --version 3 --db data/uas.db              # print it
 *   npm run prompts:export -- --template plan --version 3 --db data/uas.db --out packages/mind/templates/plan.json
 *
 * Reads the database read-only. Making an exported version the repo default changes the golden
 * prompts: run `npm run eval -- --update-prompts` and review the diff.
 */
import { writeFileSync } from 'node:fs';
import { TEMPLATES, TEMPLATE_IDS, validateTemplate, type TemplateId } from '@uas/mind';
import { readPromptVersion } from '@uas/store';

const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const id = opt('--template') as TemplateId | undefined;
const version = Number(opt('--version'));
const db = opt('--db');
if (!id || !TEMPLATE_IDS.includes(id) || !Number.isInteger(version) || !db) {
  console.error(`usage: npm run prompts:export -- --template <${TEMPLATE_IDS.join('|')}> --version <n> --db <path> [--out <file>]`);
  process.exit(2);
}
const row = readPromptVersion(db, id, version);
if (!row) {
  console.error(`no version ${version} of ${id} in ${db}`);
  process.exit(1);
}
const check = validateTemplate(id, row.body);
if (!check.ok) {
  console.error(`${id}@${version} doesn't validate any more: ${check.errors.map((e) => `${e.part}: ${e.message}`).join('; ')}`);
  process.exit(1);
}
const t = TEMPLATES[id];
const text = `${JSON.stringify({ id, name: t.name, description: t.description, parts: row.body.parts }, null, 2)}\n`;
const out = opt('--out');
if (out) {
  writeFileSync(out, text);
  console.log(`wrote ${id}@${version} (${row.note || 'no note'}) to ${out}`);
} else process.stdout.write(text);
