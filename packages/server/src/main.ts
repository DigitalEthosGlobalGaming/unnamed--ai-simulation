import { mkdirSync } from 'node:fs';
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
const app = createApp({ dbPath, keys });

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
