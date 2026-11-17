/**
 * Save a moment from a running server as an eval situation:
 *
 *   npm run eval:capture -- --world garden --character robot [--tick N] [--title "..."] [--why "..."] [--tags a,b]
 *                           [--url http://localhost:8080]
 *
 * Calls `POST /worlds/:id/characters/:cid/situation` with an admin API key (UAS_ADMIN_KEY, or the
 * first of UAS_ADMIN_KEYS; never printed) and writes evals/situations/captured/<id>.json. Then fill
 * in its TODO checks and run `npm run eval -- --update-prompts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, SITUATIONS_DIR, parseSituation } from '../src/index.ts';

const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const world = opt('--world') ?? 'garden';
const character = opt('--character') ?? 'robot';
const url = (opt('--url') ?? process.env.UAS_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.UAS_ADMIN_KEY ?? process.env.UAS_ADMIN_KEYS?.split(',')[0]?.trim();
if (!key) {
  console.error('needs an admin API key: set UAS_ADMIN_KEY (or UAS_ADMIN_KEYS) in .env or the environment');
  process.exit(2);
}
const body = {
  ...(opt('--tick') !== undefined && { tick: Number(opt('--tick')) }),
  ...(opt('--title') && { title: opt('--title') }),
  ...(opt('--why') && { why: opt('--why') }),
  ...(opt('--tags') && { tags: opt('--tags')!.split(',') }),
};
const res = await fetch(`${url}/worlds/${encodeURIComponent(world)}/characters/${encodeURIComponent(character)}/situation`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
const data = (await res.json()) as { situation?: unknown; error?: string };
if (!res.ok || !data.situation) {
  console.error(`capture failed: HTTP ${res.status} ${data.error ?? ''}`);
  process.exit(1);
}
const s = parseSituation(data.situation);
const dir = join(SITUATIONS_DIR, 'captured');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${s.id}.json`);
writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
console.log(`wrote ${relative(REPO_ROOT, file)}: fill in its TODO checks and "why", then npm run eval -- --update-prompts`);
