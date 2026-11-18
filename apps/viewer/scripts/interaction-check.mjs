// Headless checks for camera gestures and the click-vs-drag selection rule.
// Usage: npm run dev (separately), then node scripts/interaction-check.mjs [baseUrl]
import { chromium } from 'playwright';

// Gestures don't depend on the data, so the checks use the deterministic offline sample.
const base = `${process.argv[2] ?? 'http://localhost:5173/'}?source=sample`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

/* ------------------------------------------------------------ desktop */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__uas?.store.world && window.__uas.scene.screenOf('rb-01'));
  await page.waitForTimeout(800);
  const canvas = await page.locator('.sheet canvas').boundingBox();
  const st = () => page.evaluate(() => ({ zoom: window.__uas.scene.zoom, view: window.__uas.scene.viewParam(), sel: window.__uas.store.selectedId, follow: window.__uas.scene.follow }));
  const robot = async (id) => {
    const p = await page.evaluate((id) => window.__uas.scene.screenOf(id), id);
    return { x: canvas.x + p.x, y: canvas.y + p.y };
  };
  // An empty spot: the pond's centre region is never walked on.
  const empty = { x: canvas.x + canvas.width * 0.52, y: canvas.y + canvas.height * 0.62 };

  let a = await st();
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  let b = await st();
  check('wheel zooms in around the cursor', b.zoom > a.zoom * 1.5, `${a.zoom.toFixed(2)} → ${b.zoom.toFixed(2)}`);

  a = b;
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 60, empty.y + 30, { steps: 6 });
  await page.mouse.up();
  b = await st();
  check('click-drag on empty sheet pans', a.view !== b.view && b.sel === null, `${a.view} → ${b.view}`);

  // Selection threshold: a 3px wobble is still a click; a 30px move is a drag.
  // Pause first so the robot holds still while the pointer moves (robots walk ~2.5 tiles/s).
  await page.click('.timeline .play');
  await page.click('[data-cam="fit"]');
  await page.waitForTimeout(2000);
  let r = await robot('rb-02');
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + 3, r.y + 2, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  b = await st();
  check('click with 3px wobble selects the robot', b.sel === 'rb-02', `selected=${b.sel}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  r = await robot('rb-02');
  await page.mouse.move(r.x, r.y);
  await page.mouse.down();
  await page.mouse.move(r.x + 30, r.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  b = await st();
  check('drag starting on a robot does not select', b.sel === null, `selected=${b.sel}`);

  await page.click('[data-cam="fit"]');
  await page.waitForTimeout(2000);
  a = await st();
  check('Fit sheet returns to zoom 1', Math.abs(a.zoom - 1) < 0.01, `zoom=${a.zoom.toFixed(3)}`);
  await page.mouse.dblclick(empty.x, empty.y);
  await page.waitForTimeout(2000);
  b = await st();
  check('double-click zooms in one step', b.zoom > 1.5, `zoom=${b.zoom.toFixed(2)}`);

  await page.click('[data-cam="in"]');
  await page.waitForTimeout(2000);
  a = await st();
  check('Zoom in button', a.zoom > b.zoom, `${b.zoom.toFixed(2)} → ${a.zoom.toFixed(2)}`);
  await page.click('[data-cam="out"]');
  await page.waitForTimeout(2000);
  b = await st();
  check('Zoom out button', b.zoom < a.zoom, `${a.zoom.toFixed(2)} → ${b.zoom.toFixed(2)}`);

  await page.focus('.sheet');
  await page.keyboard.press('0');
  // Headless software rendering runs at a few frames per second; wait for the eased fit to settle.
  await page.waitForFunction(() => Math.abs(window.__uas.scene.zoom - 1) < 0.01, null, { timeout: 8000 }).catch(() => {});
  a = await st();
  await page.keyboard.press('+');
  await page.waitForTimeout(2000);
  b = await st();
  check('keyboard 0 fits and + zooms', Math.abs(a.zoom - 1) < 0.01 && b.zoom > 1.2, `0→${a.zoom.toFixed(2)}, +→${b.zoom.toFixed(2)}`);
  a = b;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  b = await st();
  check('keyboard arrow pans', a.view !== b.view, `${a.view} → ${b.view}`);
  await page.keyboard.press('-');
  await page.waitForTimeout(2000);
  a = await st();
  check('keyboard - zooms out', a.zoom < b.zoom, `${b.zoom.toFixed(2)} → ${a.zoom.toFixed(2)}`);

  await page.evaluate(() => window.__uas.store.select('rb-01'));
  await page.click('[data-cam="follow"]');
  await page.waitForTimeout(2000);
  a = await st();
  const centred = await page.evaluate(() => {
    const s = window.__uas.scene;
    const p = s.screenOf('rb-01');
    const c = document.querySelector('.sheet canvas').getBoundingClientRect();
    return { dx: p.x - c.width / 2, dy: p.y };
  });
  check('Follow selected turns on and zooms in', a.follow && a.zoom > 1.5, `follow=${a.follow} zoom=${a.zoom.toFixed(2)} dx=${centred.dx.toFixed(0)}`);
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x - 50, empty.y, { steps: 5 });
  await page.mouse.up();
  b = await st();
  const pressed = await page.getAttribute('[data-cam="follow"]', 'aria-pressed');
  check('panning switches Follow off', !b.follow && pressed === 'false', `follow=${b.follow} aria-pressed=${pressed}`);

  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  a = await st();
  check('zoom out is limited to just below fit', a.zoom >= 0.89 && a.zoom <= 0.91, `zoom=${a.zoom.toFixed(3)}`);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  a = await st();
  await page.mouse.move(empty.x, empty.y);
  await page.mouse.down();
  await page.mouse.move(empty.x + 4000, empty.y + 4000, { steps: 20 });
  await page.mouse.up();
  b = await st();
  const [cx, cy] = b.view.split(',').map(Number);
  check('panning is clamped to the sheet', cx >= 0 && cx <= 24 && cy >= 0 && cy <= 16, `max zoom ${a.zoom.toFixed(2)}, view after huge drag ${b.view}`);
  // Revision links: a timeline belief marker seeks and lights its feed row; a row button lights its marker.
  await page.evaluate(() => window.__uas.store.select('rb-03'));
  await page.waitForTimeout(800);
  const marker = page.locator('.scale-markers .marker').nth(1);
  const mtick = Number(await marker.getAttribute('data-tick'));
  await marker.click();
  await page.waitForTimeout(1500);
  const lit = await page.evaluate(() => ({ h: window.__uas.store.highlight, tick: window.__uas.store.tick, row: !!document.querySelector('.fe-row.is-lit, .fe-sub-row.is-lit') }));
  check('belief marker seeks and lights its revision row', lit.h === `${mtick}:rb-03` && lit.row && Math.abs(lit.tick - mtick) < 10, JSON.stringify(lit));
  await page.locator('.fe-row .rev-btn').first().click();
  await page.waitForTimeout(600);
  const h2 = await page.evaluate(() => window.__uas.store.highlight);
  check('revision button toggles the highlight', h2 !== lit.h, `${lit.h} → ${h2}`);

  const scale = await page.textContent('[data-tb="scale"]');
  check('title block SCALE shows the live value', /%/.test(scale ?? ''), scale ?? '');

  // Brain feed: paging, collapsed runs, the tier detail popover, and the "new decisions" button.
  await page.evaluate(() => {
    window.__uas.store.goLive();
    window.__uas.store.select(null);
    window.__uas.store.setHighlight(null);
  });
  await page.waitForTimeout(1500);
  const rows0 = await page.locator('.fe-row').count();
  await page.click('[data-feed="older"]');
  await page.waitForTimeout(600);
  const rows1 = await page.locator('.fe-row').count();
  check('feed shows 25 rows, Load older adds a page', rows0 === 25 && rows1 === 50, `${rows0} → ${rows1}`);
  // Runs depend on the data: look through each robot's feed until one shows a collapsed run.
  for (const id of [null, 'rb-01', 'rb-02', 'rb-03']) {
    if (await page.locator('.fe-expand').count()) break;
    await page.evaluate((id) => window.__uas.store.select(id), id);
    await page.waitForTimeout(500);
    if (!(await page.locator('.fe-expand').count())) {
      await page.click('[data-feed="older"]').catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  const run = page.locator('.fe-expand').first();
  if (await run.count()) {
    await run.click();
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => ({ exp: document.querySelector('.fe-expand[aria-expanded="true"]') !== null, sub: document.querySelectorAll('.fe-sub .fe-sub-row').length }));
    check('a collapsed run expands to its entries', st.exp && st.sub > 1, JSON.stringify(st));
  } else check('a collapsed run expands to its entries', false, 'no run in view');
  const tier = page.locator('.fe-row .tier-btn').first();
  await tier.click();
  await page.waitForTimeout(200);
  const open1 = await page.evaluate(() => document.querySelector('#tier-pop')?.matches(':popover-open') && document.querySelector('.tier-btn[aria-expanded="true"]') !== null);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ open: document.querySelector('#tier-pop')?.matches(':popover-open'), focus: document.activeElement?.classList.contains('tier-btn') }));
  check('tier mark opens the model detail; Escape closes it and returns focus', open1 && !after.open && after.focus, JSON.stringify({ open1, ...after }));
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const kb = await page.evaluate(() => document.querySelector('#tier-pop')?.matches(':popover-open'));
  check('keyboard focus on a tier mark shows the detail', !!kb, `open=${kb}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const pb = document.querySelector('#panel-body');
    const list = document.querySelector('.feed-list');
    pb.scrollTop += list.getBoundingClientRect().top - pb.getBoundingClientRect().top + 400;
    pb.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(300);
  // A live entry arriving while scrolled back waits behind the button instead of moving the list.
  await page.evaluate(() => {
    const s = window.__uas.store;
    const last = s.feed[s.feed.length - 1];
    s.onMessage({ type: 'feed', worldId: 'garden-01', entry: { ...last, tick: s.tick + 1, actions: [{ verb: 'rest', reason: 'test entry', status: 'queued' }] } });
  });
  await page.waitForTimeout(500);
  const pill = await page.evaluate(() => ({ text: document.querySelector('.new-pill:not([hidden])')?.textContent ?? '', top: document.querySelector('.fe-row .fe-do')?.textContent ?? '' }));
  check('new live entries wait behind "N new decisions" while scrolled back', /\d+ new decisions?/.test(pill.text) && !/test entry/.test(pill.top), JSON.stringify(pill));
  await page.click('.new-pill');
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => ({ hidden: document.querySelector('.new-pill')?.hidden, why: [...document.querySelectorAll('.fe-row')].slice(0, 3).map((r) => r.textContent).join(' ') }));
  check('the button shows the newest decisions', shown.hidden && /test entry/i.test(shown.why), JSON.stringify(shown));
  await ctx.close();
}

/* -------------------------------------------------------------- phone */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`${base}&drawer=peek`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__uas?.store.world && window.__uas.scene.screenOf('rb-01'));
  await page.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(page);
  const canvas = await page.locator('.sheet canvas').boundingBox();
  const zoom = () => page.evaluate(() => window.__uas.scene.zoom);
  const scrollY = () => page.evaluate(() => [window.scrollY, document.scrollingElement.scrollTop]);
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + 200;
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  const pair = (d) => [{ x: cx - d, y: cy, id: 0 }, { x: cx + d, y: cy, id: 1 }];

  const z0 = await zoom();
  await touch('touchStart', pair(30));
  for (let d = 34; d <= 120; d += 4) await touch('touchMove', pair(d));
  await touch('touchEnd', []);
  await page.waitForTimeout(200);
  const z1 = await zoom();
  check('pinch zooms (touch)', z1 > z0 * 2, `${z0.toFixed(2)} → ${z1.toFixed(2)}`);

  const v0 = await page.evaluate(() => window.__uas.scene.viewParam());
  await touch('touchStart', [{ x: cx, y: cy, id: 0 }]);
  for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: cx + i * 6, y: cy + i * 4, id: 0 }]);
  await touch('touchEnd', []);
  const v1 = await page.evaluate(() => window.__uas.scene.viewParam());
  const s = await scrollY();
  check('one-finger drag pans, page does not scroll', v0 !== v1 && s[0] === 0 && s[1] === 0, `${v0} → ${v1}, scroll ${s}`);

  await page.evaluate(() => window.__uas.scene.fit());
  await page.waitForTimeout(2000);
  const tapAt = { x: cx, y: canvas.y + 150 };
  await touch('touchStart', [{ ...tapAt, id: 0 }]);
  await touch('touchEnd', []);
  await touch('touchStart', [{ ...tapAt, id: 0 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(2000);
  const z2 = await zoom();
  check('double-tap zooms in', z2 > 1.5, `zoom=${z2.toFixed(2)}`);

  await page.evaluate(() => window.__uas.scene.fit());
  await page.waitForTimeout(2000);
  const p = await page.evaluate(() => window.__uas.scene.screenOf('rb-02'));
  await page.waitForTimeout(400);
  await touch('touchStart', [{ x: canvas.x + p.x, y: canvas.y + p.y, id: 0 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(150);
  const sel = await page.evaluate(() => window.__uas.store.selectedId);
  check('tap on a robot selects it', sel === 'rb-02', `selected=${sel}`);

  const before = await page.getAttribute('.panel', 'data-drawer');
  await page.tap('[data-ref="handle"]');
  await page.waitForTimeout(400);
  const after = await page.getAttribute('.panel', 'data-drawer');
  check('drawer handle still works', before !== after, `${before} → ${after}`);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
