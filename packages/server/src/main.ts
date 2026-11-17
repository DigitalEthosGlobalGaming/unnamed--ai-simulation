import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { KeyRing } from './auth.ts';
import { createApp } from './app.ts';
import { loadWorldsDir } from './config.ts';

const env = process.env;
const dbPath = resolve(env.UAS_DB ?? 'data/uas.db');
const worldsDir = resolve(env.UAS_WORLDS ?? 'worlds');
const port = Number(env.PORT ?? 8080);

mkdirSync(dirname(dbPath), { recursive: true });
const keys = KeyRing.fromEnv(env);
ensureSessionSecret();
// Captured eval situations are written into the repo when the server runs from it (UAS_SITUATIONS_DIR overrides; 'none' disables).
const situationsDir = env.UAS_SITUATIONS_DIR === 'none' ? undefined : env.UAS_SITUATIONS_DIR ? resolve(env.UAS_SITUATIONS_DIR) : existsSync(resolve('evals/situations')) ? resolve('evals/situations/captured') : undefined;
const app = createApp({ dbPath, keys, authEnv: env, ...(situationsDir && { situationsDir }) });
console.log(env.VERCEL_OAUTH_CLIENT_ID ? `Sign in with Vercel: on (callback ${(env.UAS_PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '')}/api/auth/callback)` : 'Sign in with Vercel: off (no VERCEL_OAUTH_CLIENT_ID)');

for (const config of loadWorldsDir(worldsDir, env)) {
  await app.startWorld(config);
  console.log(`world ${config.id} running (${config.packs.join(', ')} on ${config.map})`);
}
app.server.listen(port, () => console.log(`Unnamed AI Simulation server on :${port} (db ${dbPath})`));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: snapshotting worlds and shutting down`);
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/** Generate UAS_SESSION_SECRET into .env on first run so sessions survive restarts. Never printed. */
function ensureSessionSecret(): void {
  if (env.UAS_SESSION_SECRET) return;
  const secret = randomBytes(32).toString('hex');
  env.UAS_SESSION_SECRET = secret;
  try {
    const file = resolve('.env');
    const fresh = !existsSync(file);
    appendFileSync(file, `${fresh ? '' : '\n'}UAS_SESSION_SECRET=${secret}\n`, { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
    console.log('generated UAS_SESSION_SECRET in .env');
  } catch {
    console.warn('UAS_SESSION_SECRET is not set and .env is not writable: sessions will end when the server restarts');
  }
}
