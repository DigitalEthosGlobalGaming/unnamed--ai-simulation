/**
 * World lifecycle (iteration 2, docs/architecture/objects.md#archiving-the-iteration-1-world).
 *
 *   npm run world:archive -- --world garden [--db data/uas.db] [--worlds worlds]
 *     1. takes an SQLite backup copy to <db dir>/archive/<world>-<date>.db (online-safe),
 *     2. sets `archived: true` in <worlds>/<world>.yaml.
 *     Restart the server: the world then loads read-only (no ticking, inputs refused with 409).
 *
 *   npm run world:new -- --world garden2 --map garden-2 [--template worlds/garden2.yaml] [--worlds worlds] [--db data/uas.db]
 *     writes <worlds>/<world>.yaml from the template with that id and map. The server creates the
 *     world at day 0 on its next start. Refuses an id the database already has.
 *
 * The owner runs these on the live database; agents only on scratch copies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

const [cmd, ...args] = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const world = opt('--world');
const db = resolve(opt('--db') ?? process.env.UAS_DB ?? 'data/uas.db');
const worlds = resolve(opt('--worlds') ?? process.env.UAS_WORLDS ?? 'worlds');
const fail = (m: string): never => {
  console.error(m);
  process.exit(2);
};
if (!world || !/^[a-z0-9-]+$/.test(world)) fail('usage: world.ts archive|new --world <id> …');

if (cmd === 'archive') {
  const file = join(worlds, `${world}.yaml`);
  if (!existsSync(file)) fail(`no ${file}`);
  if (!existsSync(db)) fail(`no database at ${db}`);
  const dir = join(dirname(db), 'archive');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `${world}-${new Date().toISOString().slice(0, 10)}.db`);
  const source = new Database(db, { readonly: true, fileMustExist: true });
  await source.backup(copy);
  source.close();
  console.log(`backed up ${db} to ${copy}`);
  const yaml = readFileSync(file, 'utf8');
  const next = /^archived:/m.test(yaml) ? yaml.replace(/^archived:.*$/m, 'archived: true') : yaml.replace(/^(id: .*)$/m, '$1\narchived: true   # read-only: no ticking, inputs refused (npm run world:archive)');
  writeFileSync(file, next);
  console.log(`${file}: archived: true. Restart the server; the world is then read-only.`);
} else if (cmd === 'new') {
  const file = join(worlds, `${world}.yaml`);
  if (existsSync(file)) fail(`${file} already exists`);
  const template = resolve(opt('--template') ?? join(worlds, 'garden2.yaml'));
  if (!existsSync(template)) fail(`no template ${template}`);
  if (existsSync(db)) {
    const conn = new Database(db, { readonly: true, fileMustExist: true });
    const row = conn.prepare('select id from worlds where id = ?').get(world);
    conn.close();
    if (row) fail(`the database already has a world "${world}"; pick another id`);
  }
  const map = opt('--map') ?? 'garden-2';
  const yaml = readFileSync(template, 'utf8')
    .replace(/^id: .*$/m, `id: ${world}`)
    .replace(/^map: .*$/m, `map: basic:${map}`)
    .replace(/^archived:.*\n/m, '');
  writeFileSync(file, yaml);
  console.log(`wrote ${file} (map basic:${map}). Start or restart the server to create it at day 0.`);
} else fail('usage: world.ts archive|new --world <id> …');
