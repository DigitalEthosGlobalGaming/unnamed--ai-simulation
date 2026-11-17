// Captures review screenshots of the viewer. Usage: npm run dev (separately), then
//   node scripts/screenshots.mjs [baseUrl]     (ONLY=desktop,mobile to limit)
// SET=real (default) captures against the world server through the Vite /api proxy; the world
// server must be running (npm start). SET=sample captures the offline sample (?source=sample) under
// names prefixed `sample-`. Noise shots need a visitor key on the server (UAS_VISITOR_KEYS) passed
// here as VISITOR_KEY: a visitor makes noises at the robot so the plan draws real sound arcs.
// Chromium needs its shared libraries; on hosts without them set LD_LIBRARY_PATH.
// Writes to ../../.impeccable/review/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../.impeccable/review');
mkdirSync(out, { recursive: true });
const base = process.argv[2] ?? 'http://localhost:5173/';

const API = process.env.API ?? 'http://localhost:8080';
const live = async () => (await (await fetch(`${API}/worlds`)).json())[0];
/** A visitor (joined once) makes a noise chain at the first robot; returns once the request is in. */
async function visitorNoise() {
  const key = process.env.VISITOR_KEY;
  if (!key) throw new Error('noise shots need VISITOR_KEY (a key from the server\'s UAS_VISITOR_KEYS)');
  const w = await live();
  const h = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const { visitorId } = await (await fetch(`${API}/worlds/${w.id}/visitors`, { method: 'POST', headers: h, body: JSON.stringify({ pos: { x: 6, y: 9 } }) })).json();
  const notes = [['beep-C', 'chirp-E'], ['trill-G', 'chirp-E', 'beep-D'], ['chirp-C', 'chirp-G']][Math.floor(Date.now() / 1000) % 3];
  await fetch(`${API}/worlds/${w.id}/visitors/${visitorId}/actions`, { method: 'POST', headers: h, body: JSON.stringify({ actions: [{ verb: 'vocalize', args: { notes, at: 'robot' }, reason: 'visitor' }] }) });
}

const realShots = [
  { name: 'desktop', vp: [1440, 900], q: '' },
  { name: 'desktop-selected', vp: [1440, 900], q: 'select=robot' },
  { name: 'desktop-beliefs', vp: [1440, 900], q: 'select=robot', click: '#tab-beliefs' },
  { name: 'desktop-replay', vp: [1440, 900], q: async () => `select=robot&at=${Math.floor((await live()).status.tick * 0.55)}` },
  { name: 'desktop-noise', vp: [1440, 900], q: 'view=6,8,2', noise: true },
  { name: 'mobile', vp: [390, 844], q: '', mobile: true },
  { name: 'mobile-drawer-peek', vp: [390, 844], q: 'select=robot&drawer=peek', mobile: true },
  { name: 'mobile-drawer-full', vp: [390, 844], q: 'select=robot&drawer=full', mobile: true },
  { name: 'mobile-replay', vp: [390, 844], q: async () => `drawer=closed&at=${Math.floor((await live()).status.tick * 0.55)}`, mobile: true },
  { name: 'mobile-noise', vp: [390, 844], q: 'drawer=closed', mobile: true, noise: true },
  { name: 'desktop-settings', vp: [1440, 900], q: '', click: '#tab-settings' },
];

const sampleShots = [
  { name: 'desktop', vp: [1440, 900], q: '' },
  { name: 'desktop-selected', vp: [1440, 900], q: 'select=rb-02' },
  { name: 'desktop-replay', vp: [1440, 900], q: 'select=rb-03&at=41200', tab: null },
  { name: 'desktop-lowbattery', vp: [1440, 900], q: 'scenario=lowbattery&select=rb-03' },
  { name: 'desktop-beliefs', vp: [1440, 900], q: 'select=rb-03', click: '#tab-beliefs', sound: true },
  { name: 'desktop-empty', vp: [1440, 900], q: 'scenario=empty' },
  { name: 'desktop-disconnected', vp: [1440, 900], q: 'state=disconnected', wait: 2600 },
  { name: 'mobile', vp: [390, 844], q: '', mobile: true },
  { name: 'mobile-drawer-closed', vp: [390, 844], q: 'drawer=closed', mobile: true },
  { name: 'mobile-drawer-peek', vp: [390, 844], q: 'select=rb-01&drawer=peek', mobile: true },
  { name: 'mobile-drawer-full', vp: [390, 844], q: 'select=rb-01&drawer=full', mobile: true },
  { name: 'mobile-replay', vp: [390, 844], q: 'at=41200&drawer=closed', mobile: true },
  { name: 'desktop-replay-belief', vp: [1440, 900], q: 'at=29420&select=rb-03&tab=beliefs' },
  { name: 'desktop-zoom-solar', vp: [1440, 900], q: 'scenario=lowbattery&view=17.5,4.5,3.2' },
  { name: 'desktop-panned', vp: [1440, 900], q: 'view=5,3.5,2.2&select=rb-01' },
  { name: 'desktop-noise', vp: [1440, 900], q: 'at=52138&view=17.5,5,2.4', noise: true },
  { name: 'mobile-zoomed', vp: [390, 844], q: 'view=13,8,2.6&drawer=closed', mobile: true },
  { name: 'mobile-pinch-peek', vp: [390, 844], q: 'select=rb-02&drawer=peek', mobile: true, pinch: true },
  {
    name: 'desktop-revision-link',
    vp: [1440, 900],
    q: 'scenario=lowbattery&select=rb-03&view=16,5,2',
    js: () => {
      const s = window.__uas.store;
      const e = s.alertEntry('rb-03');
      if (e) s.setHighlight(`${e.tick}:${e.characterId}`, true);
    },
  },
  { name: 'mobile-noise', vp: [390, 844], q: 'at=52138&drawer=closed', mobile: true, noise: true },
  // Accounts and world settings (sample mocks the contract; ?as= picks the role).
  { name: 'desktop-settings-admin', vp: [1440, 900], q: 'as=admin', click: '#tab-settings' },
  { name: 'desktop-settings-error', vp: [1440, 900], q: 'as=admin', click: '#tab-settings', type: { sel: '#set-ticksPerRealSecond', value: '99' } },
  { name: 'desktop-settings-signedout', vp: [1440, 900], q: '', click: '#tab-settings' },
  { name: 'mobile-settings-admin', vp: [390, 844], q: 'as=admin&drawer=full', mobile: true, click: '#tab-settings' },
].map((s) => ({ ...s, name: `sample-${s.name}`, sample: true, q: `source=sample${s.q ? `&${s.q}` : ''}` }));

const shots = process.env.SET === 'sample' ? sampleShots : realShots;

const only = process.env.ONLY?.split(',');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  const ctx = await browser.newContext({
    viewport: { width: s.vp[0], height: s.vp[1] },
    deviceScaleFactor: s.mobile ? 2 : 1,
    isMobile: !!s.mobile,
    hasTouch: !!s.mobile,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${s.name}] pageerror`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${s.name}] console`, m.text()));
  const q = typeof s.q === 'function' ? await s.q() : s.q;
  await page.goto(`${base}?${q}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__uas?.store.world, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(s.wait ?? 3200);
  if (s.sound) await page.click('[data-ref="sound-btn"]');
  if (s.js) {
    await page.evaluate(s.js);
    await page.waitForTimeout(800);
  }
  if (s.pinch) {
    // Two-finger pinch-out around the plan centre via CDP touch events.
    const cdp = await ctx.newCDPSession(page);
    const box = await page.locator('.sheet canvas').boundingBox();
    const at = await page.evaluate(() => window.__uas.scene.screenOf(window.__uas.store.selectedId ?? 'rb-01'));
    const cx = box.x + at.x;
    const cy = box.y + at.y;
    const pts = (d) => [{ x: cx - d, y: cy, id: 0 }, { x: cx + d, y: cy, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(30) });
    for (let d = 34; d <= 110; d += 4) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(600);
  }
  if (s.noise) {
    // Sample: replay a stretch where robots trade note chains. Real: a visitor makes noises at the robot.
    if (s.sample) await page.click('.timeline .play');
    else await visitorNoise();
    await page.waitForFunction(() => window.__uas?.store.noises.some((n) => performance.now() - n.at < 300), null, { timeout: 90000, polling: 50 });
    await page.waitForTimeout(450);
  }
  if (s.click) {
    await page.click(s.click);
    await page.waitForTimeout(800);
  }
  if (s.type) {
    await page.fill(s.type.sel, s.type.value);
    await page.press(s.type.sel, 'Enter');
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: `${out}/${s.name}.png` });
  console.log('saved', s.name);
  await ctx.close();
}
await browser.close();
