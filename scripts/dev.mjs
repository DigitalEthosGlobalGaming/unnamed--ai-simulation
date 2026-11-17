#!/usr/bin/env node
// Run the server and the viewer dev server together with prefixed output.
//   node scripts/dev.mjs          the default: hosted models through AI Gateway when AI_GATEWAY_API_KEY
//                                 is set (in .env or the environment), otherwise local Ollama models
//                                 (Laya decides, small local text models), with autopilot as the last resort
//   node scripts/dev.mjs --fake   offline fake models (no Ollama, no network)
import { spawn } from 'node:child_process';

try {
  process.loadEnvFile('.env'); // never printed; the server reads it too (node --env-file-if-exists)
} catch {
  /* no .env */
}
const fake = process.argv.includes('--fake');
const env = { ...process.env, UAS_ADMIN_KEYS: process.env.UAS_ADMIN_KEYS ?? 'dev-admin' };
const hosted = !fake && !!env.AI_GATEWAY_API_KEY;
if (fake) {
  Object.assign(env, { UAS_DECIDER: 'fake', UAS_SCORER: 'fake', UAS_PLANNER: 'fakeChat', UAS_REFLECTOR: 'fakeChat' });
} else {
  // Without hosted Jev to escalate to, a local plan would double a decision's latency on CPU,
  // so only very unsure decisions escalate.
  if (!hosted) env.UAS_ESCALATE_BELOW ??= '0.15';
  const url = env.OLLAMA_URL ?? 'http://localhost:11434';
  try {
    await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.warn(`[dev] Ollama is not reachable at ${url}${hosted ? '' : ' and AI_GATEWAY_API_KEY is not set'}; ${hosted ? 'local fallbacks are off' : 'the robot will run on autopilot'}. Run \`npm run ollama:up && npm run ollama:pull\`, or \`npm run dev:fake\` to run offline on purpose.`);
  }
}

const colours = { server: 36, viewer: 35 };
const children = [];
function run(name, args) {
  // Own process group, so stopping kills npm and everything it started (node, vite).
  const child = spawn('npm', args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const prefix = `\x1b[${colours[name]}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) process.stdout.write(prefix + l + '\n');
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      c.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`[dev] server on :${env.PORT ?? 8080} (${fake ? 'offline fake models' : hosted ? 'hosted models via AI Gateway, local fallbacks' : 'local Ollama models (no AI_GATEWAY_API_KEY)'}), admin key "${env.UAS_ADMIN_KEYS}"`);
run('server', ['start']);
run('viewer', ['run', 'dev', '--workspace', 'apps/viewer']);
