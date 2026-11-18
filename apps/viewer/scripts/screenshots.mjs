// Captures review screenshots of the viewer. Usage: npm run dev (separately), then
//   node scripts/screenshots.mjs [baseUrl]     (ONLY=desktop,mobile to limit)
// SET=real (default) captures against the world server through the Vite /api proxy; the world
// server must be running (npm start). SET=sample captures the offline sample (?source=sample) under
// names prefixed `sample-` (noise shots replay a stretch of the sample where robots trade notes).
// `steps` run in order: { click }, { type: {sel, value} } (fills, no Enter), { tile: [x, y] } taps a
// plan tile, { wait }.
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
const realShots = [
  { name: 'desktop', vp: [1440, 900], q: '' },
  { name: 'desktop-selected', vp: [1440, 900], q: 'select=robot' },
  { name: 'desktop-beliefs', vp: [1440, 900], q: 'select=robot', click: '#tab-beliefs' },
  { name: 'desktop-replay', vp: [1440, 900], q: async () => `select=robot&at=${Math.floor((await live()).status.tick * 0.55)}` },
  { name: 'mobile', vp: [390, 844], q: '', mobile: true },
  { name: 'mobile-drawer-peek', vp: [390, 844], q: 'select=robot&drawer=peek', mobile: true },
  { name: 'mobile-drawer-full', vp: [390, 844], q: 'select=robot&drawer=full', mobile: true },
  { name: 'mobile-replay', vp: [390, 844], q: async () => `drawer=closed&at=${Math.floor((await live()).status.tick * 0.55)}`, mobile: true },
  { name: 'desktop-settings', vp: [1440, 900], q: '', click: '#tab-settings' },
  // Brain feed: hierarchy, collapsed runs, the model/cost popover, phone drawer.
  { name: 'desktop-feed-popover', vp: [1440, 900], q: 'select=robot', steps: [{ click: '.fe-row .tier-btn' }] },
  { name: 'desktop-feed-run', vp: [1440, 900], q: 'select=robot', steps: [{ js: () => document.querySelector('.fe-expand')?.click() }] },
  { name: 'desktop-feed-all', vp: [1440, 900], q: '' },
  {
    name: 'desktop-feed-newpill',
    vp: [1440, 900],
    q: 'select=robot',
    steps: [{ js: () => (document.querySelector('#panel-body').scrollTop = 900), wait: 300 }, { js: () => document.querySelector('#panel-body').dispatchEvent(new Event('scroll')), wait: 30000 }],
  },
  { name: 'mobile-feed', vp: [390, 844], q: 'select=robot&drawer=full', mobile: true, steps: [{ js: () => document.querySelector('.feed-view')?.scrollIntoView() }] },
  { name: 'mobile-feed-popover', vp: [390, 844], q: 'select=robot&drawer=full', mobile: true, steps: [{ js: () => document.querySelector('.feed-view')?.scrollIntoView() }, { click: '.fe-row .tier-btn' }] },
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
  // Brain feed.
  { name: 'desktop-feed-popover', vp: [1440, 900], q: 'select=rb-03', steps: [{ click: '.fe-row .tier-btn' }] },
  { name: 'desktop-feed-run', vp: [1440, 900], q: 'select=rb-01', steps: [{ js: () => document.querySelector('.fe-expand')?.click() }] },
  { name: 'desktop-feed-all', vp: [1440, 900], q: '' },
  { name: 'desktop-feed-problems', vp: [1440, 900], q: 'scenario=lowbattery&select=rb-03', steps: [{ click: '[data-feed="filter"][data-id="problems"]' }] },
  {
    name: 'desktop-feed-newpill',
    vp: [1440, 900],
    q: '',
    steps: [{ js: () => (document.querySelector('#panel-body').scrollTop = 900), wait: 300 }, { js: () => document.querySelector('#panel-body').dispatchEvent(new Event('scroll')), wait: 20000 }],
  },
  { name: 'mobile-feed', vp: [390, 844], q: 'select=rb-01&drawer=full', mobile: true, steps: [{ js: () => document.querySelector('.feed-view')?.scrollIntoView() }] },
  { name: 'mobile-feed-popover', vp: [390, 844], q: 'select=rb-01&drawer=full', mobile: true, steps: [{ js: () => document.querySelector('.feed-view')?.scrollIntoView() }, { click: '.fe-row .tier-btn' }] },
  // Iteration 2: thinking budget, sleep pressure and fog, sleep work, thinking depth.
  { name: 'desktop-budget', vp: [1440, 900], q: 'select=rb-02', steps: [{ hover: '.gauge[data-key="energy"]' }] },
  { name: 'desktop-asleep', vp: [1440, 900], q: 'select=rb-01&at=40900' },
  { name: 'desktop-asleep-work', vp: [1440, 900], q: 'select=rb-01&at=40180' },
  { name: 'mobile-budget', vp: [390, 844], q: 'select=rb-02&drawer=full', mobile: true },
  {
    name: 'desktop-settings-bands',
    vp: [1440, 900],
    q: 'as=admin',
    click: '#tab-settings',
    steps: [{ js: () => document.querySelector('#set-batteryPlanAbove')?.scrollIntoView({ block: 'start' }) }, { type: { sel: '#set-batteryTopUp', value: '0.25' } }, { js: () => document.querySelector('#set-batteryTopUp').dispatchEvent(new Event('change', { bubbles: true })), wait: 900 }],
  },
  { name: 'desktop-depth-popover', vp: [1440, 900], q: 'select=rb-03', steps: [{ click: '.fe-row .tier-btn' }] },
  // Iteration 2 Stage 4: thoughts, the sheet, history.
  { name: 'desktop-thought', vp: [1440, 900], q: 'select=rb-02' },
  { name: 'desktop-thought-asleep', vp: [1440, 900], q: 'select=rb-01&at=40180' },
  { name: 'desktop-sheet', vp: [1440, 900], q: 'select=rb-01', click: '#tab-sheet' },
  { name: 'desktop-plant-history', vp: [1440, 900], q: 'open=obj:obj-plant-1', wait: 4500 },
  { name: 'mobile-thought', vp: [390, 844], q: 'select=rb-02&drawer=peek', mobile: true },
  { name: 'mobile-sheet', vp: [390, 844], q: 'select=rb-01&drawer=full', mobile: true, click: '#tab-sheet' },
  { name: 'mobile-sheet-nights', vp: [390, 844], q: 'select=rb-01&drawer=full', mobile: true, click: '#tab-sheet', steps: [{ js: () => document.querySelector('.sh-nights')?.scrollIntoView({ block: 'center' }) }] },
  {
    name: 'desktop-thought-unselected',
    vp: [1440, 900],
    q: '',
    // wait for a robot to have a new thought, then capture inside its ~7 s window
    steps: [
      {
        js: () =>
          new Promise((done) => {
            const t = setInterval(() => {
              const tt = window.__uas.scene.thoughtT;
              if (tt?.visible && tt.alpha === 1) {
                clearInterval(t);
                setTimeout(done, 400);
              }
            }, 150);
            setTimeout(() => (clearInterval(t), done()), 60000);
          }),
      },
    ],
  },
  { name: 'desktop-depth-popover-gut', vp: [1440, 900], q: 'select=rb-02', steps: [{ js: () => [...document.querySelectorAll('.fe-row .tier-btn')].find((b) => /gut|mixed/i.test(b.textContent))?.click(), wait: 500 }] },
  { name: 'mobile-plant-history', vp: [390, 844], q: 'open=obj:obj-plant-1', mobile: true, wait: 4500 },
  // Iteration 2 Stage 3: the Prompts page.
  { name: 'desktop-prompts-preview', vp: [1440, 900], q: 'as=admin&page=prompts&template=plan', wait: 3000, steps: [{ click: '#pr-tab-preview', wait: 900 }] },
  { name: 'desktop-prompts-diff', vp: [1440, 900], q: 'as=admin&page=prompts&template=plan', wait: 3000, steps: [{ click: '#pr-tab-diff', wait: 600 }] },
  {
    name: 'desktop-prompts-errors',
    vp: [1440, 900],
    q: 'as=admin&page=prompts&template=decide',
    wait: 3000,
    steps: [
      { js: () => { const t = document.querySelector('textarea[data-part="sheet"]'); t.value += '\nRecent: {{recent}} and {{mood}}'; t.dispatchEvent(new Event('input', { bubbles: true })); }, wait: 300 },
      { js: () => { const t = document.querySelector('textarea[data-part="question"]'); t.value = t.value.replace('{{question}}', '{{questoin}}'); t.dispatchEvent(new Event('input', { bubbles: true })); }, wait: 900 },
    ],
  },
  {
    name: 'desktop-prompts-test',
    vp: [1440, 900],
    q: 'as=admin&page=prompts&template=plan',
    wait: 3000,
    steps: [{ click: '#pr-tab-test', wait: 400 }, { click: '[data-act="estimate"]', wait: 600 }, { click: '[data-act="run-test"]', wait: 12500 }],
  },
  { name: 'desktop-prompts-estimate', vp: [1440, 900], q: 'as=admin&page=prompts&template=plan', wait: 3000, steps: [{ click: '#pr-tab-test', wait: 400 }, { click: '[data-act="estimate"]', wait: 600 }] },
  { name: 'mobile-admin-topbar', vp: [390, 844], q: 'as=admin&drawer=full', mobile: true },
  { name: 'mobile-prompts', vp: [390, 844], q: 'as=admin&page=prompts&template=plan', mobile: true, wait: 3000, steps: [{ click: '#pr-tab-diff', wait: 500 }] },
  { name: 'mobile-prompts-activate', vp: [390, 844], q: 'as=admin&page=prompts&template=plan', mobile: true, wait: 3000, steps: [{ click: '.pr-world [data-act="ask-activate"]', wait: 500 }] },
  // Iteration 2 Stage 2: the new garden, object cards, archived worlds.
  { name: 'desktop-garden', vp: [1440, 900], q: 'view=11.5,2.5,2.6&open=obj:obj-plant-1', wait: 3800 },
  { name: 'desktop-plant-card', vp: [1440, 900], q: 'open=obj:obj-plant-1', wait: 3800 },
  { name: 'desktop-mast', vp: [1440, 900], q: 'open=obj:obj-mast', wait: 3800 },
  {
    name: 'desktop-planted-card',
    vp: [1440, 900],
    q: 'view=11.5,2.5,2.6',
    steps: [{ js: () => window.__uas.scene.onSelectObject(window.__uas.store.world.objects.find((o) => o.createdBy).id), wait: 900 }],
  },
  { name: 'desktop-can', vp: [1440, 900], q: 'view=13,12.5,3&open=obj:obj-can', wait: 3800 },
  { name: 'desktop-archived', vp: [1440, 900], q: 'archived=1', wait: 3800 },
  { name: 'mobile-plant-card', vp: [390, 844], q: 'open=obj:obj-plant-1', mobile: true, wait: 3800 },
  { name: 'mobile-garden', vp: [390, 844], q: 'view=11.5,2.5,2.4&drawer=closed', mobile: true },
  // Visitors: airdrops, the mailbox and the catalogue (sample mocks the API).
  { name: 'desktop-drops', vp: [1440, 900], q: 'as=visitor&view=12,10,1.6' },
  { name: 'desktop-item-card', vp: [1440, 900], q: 'as=admin&open=drop:d1', wait: 3800, steps: [{ click: '[data-act="json"]' }] },
  { name: 'desktop-airdrop-pick', vp: [1440, 900], q: 'as=visitor&open=airdrop', wait: 3800 },
  {
    name: 'desktop-airdrop-place',
    vp: [1440, 900],
    q: 'as=visitor&open=airdrop',
    wait: 3800,
    steps: [{ click: 'input[name="pick"][value="cool-pack"]' }, { click: '[data-act="next"]' }, { tile: [15, 9] }],
  },
  {
    name: 'desktop-airdrop-error',
    vp: [1440, 900],
    q: 'as=visitor&open=airdrop',
    wait: 3800,
    steps: [
      { click: 'input[name="pick"][value="parasol"]' }, { click: '[data-act="next"]' }, { tile: [15, 9] }, { click: '[data-act="confirm"]' }, { wait: 900 },
      { click: '[data-act="again"]' }, { click: 'input[name="pick"][value="cool-pack"]' }, { click: '[data-act="next"]' }, { tile: [16, 12] }, { click: '[data-act="confirm"]' },
    ],
  },
  { name: 'desktop-airdrop-spectator', vp: [1440, 900], q: 'open=airdrop', wait: 3800 },
  { name: 'desktop-mail', vp: [1440, 900], q: 'as=visitor&open=mail', wait: 3800, steps: [{ type: { sel: '#mail-text', value: 'Hello robot. The parasol by the pond is for you, it keeps the sun off.' } }] },
  { name: 'desktop-mail-admin', vp: [1440, 900], q: 'as=admin&open=mail', wait: 3800 },
  { name: 'desktop-catalogue', vp: [1440, 900], q: 'as=admin&page=catalogue&item=battery-snack', wait: 3000 },
  {
    name: 'desktop-catalogue-errors',
    vp: [1440, 900],
    q: 'as=admin&page=catalogue&item=squeaky-ball',
    wait: 3000,
    js: () => {
      const t = document.querySelector('#cat-json');
      t.value = t.value.replace('"squeak"', '"squeak me"').replace(/"range": \d+/, '"range": 40');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    },
  },
  { name: 'desktop-settings-catalogue', vp: [1440, 900], q: 'as=admin', click: '#tab-settings', steps: [{ js: () => document.querySelector('.item-checks')?.scrollIntoView() }] },
  { name: 'mobile-mailbox', vp: [390, 844], q: 'as=visitor&drawer=closed&view=10,13,2.2', mobile: true },
  { name: 'mobile-airdrop', vp: [390, 844], q: 'as=visitor&open=airdrop', mobile: true, wait: 3800 },
  {
    name: 'mobile-airdrop-place',
    vp: [390, 844],
    q: 'as=visitor&open=airdrop',
    mobile: true,
    wait: 3800,
    steps: [{ click: 'input[name="pick"][value="squeaky-ball"]' }, { click: '[data-act="next"]' }, { tile: [14, 8] }],
  },
  { name: 'mobile-mail', vp: [390, 844], q: 'as=visitor&open=mail', mobile: true, wait: 3800 },
  { name: 'mobile-item-card', vp: [390, 844], q: 'as=visitor&open=drop:d2', mobile: true, wait: 3800 },
  { name: 'mobile-catalogue', vp: [390, 844], q: 'as=admin&page=catalogue&item=battery-snack', mobile: true, wait: 3000 },
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
    // Replay a stretch of the sample where robots trade note chains.
    await page.click('.timeline .play');
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
  for (const st of s.steps ?? []) {
    if (st.click) await page.click(st.click);
    if (st.hover) await page.hover(st.hover);
    if (st.type) await page.fill(st.type.sel, st.type.value);
    if (st.js) await page.evaluate(st.js);
    if (st.tile) {
      const box = await page.locator('.sheet canvas').boundingBox();
      const at = await page.evaluate(([x, y]) => window.__uas.scene.screenOfTile(x, y), st.tile);
      if (s.mobile) await page.touchscreen.tap(box.x + at.x, box.y + at.y);
      else await page.mouse.click(box.x + at.x, box.y + at.y);
    }
    await page.waitForTimeout(st.wait ?? 500);
  }
  await page.screenshot({ path: `${out}/${s.name}.png` });
  console.log('saved', s.name);
  await ctx.close();
}
await browser.close();
