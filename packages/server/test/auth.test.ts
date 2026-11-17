import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { KeyRing, createApp, type App } from '../src/index.ts';

const PUBLIC = 'http://localhost:5173';
const apps: App[] = [];

async function start(env: Record<string, string>, authFetch?: typeof fetch) {
  const app = createApp({ dbPath: join(mkdtempSync(join(tmpdir(), 'uas-auth-')), 'uas.db'), keys: new KeyRing([{ key: 'admin-key', role: 'admin' }]), log: () => {}, authEnv: env, ...(authFetch && { authFetch }) });
  apps.push(app);
  await new Promise<void>((r) => app.server.listen(0, r));
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
afterAll(async () => {
  for (const a of apps) await a.close();
});

/** Fake Vercel: token exchange returns an id_token with the nonce it was given at authorize time. */
function fakeVercel(username: string) {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  let nonce = '';
  const fn: typeof fetch = async (url, init) => {
    const body = String(init?.body ?? '');
    calls.push({ url: String(url), body, auth: new Headers(init?.headers).get('authorization') });
    if (String(url).endsWith('/login/oauth/token')) {
      const idToken = ['h', Buffer.from(JSON.stringify({ sub: 'user_123', nonce })).toString('base64url'), 's'].join('.');
      return new Response(JSON.stringify({ access_token: 'vercel-access', id_token: idToken, token_type: 'Bearer', expires_in: 3600 }));
    }
    if (String(url).endsWith('/login/oauth/userinfo')) {
      return new Response(JSON.stringify({ sub: 'user_123', name: 'Test User', email: 't@example.com', preferred_username: username, picture: 'https://example.com/a.png' }));
    }
    return new Response('{}');
  };
  return { fn, calls, setNonce: (n: string) => (nonce = n) };
}

const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).join('; ');

describe('Sign in with Vercel', () => {
  it('without a client id, login is simply unavailable', async () => {
    const base = await start({});
    expect(await (await fetch(`${base}/auth/me`)).json()).toEqual({ user: null, role: 'spectator', loginAvailable: false });
    expect((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status).toBe(404);
    // An API key reports its role.
    expect(await (await fetch(`${base}/auth/me`, { headers: { authorization: 'Bearer admin-key' } })).json()).toEqual({ user: null, role: 'admin', loginAvailable: false });
  });

  it('PKCE login → session cookie → admin by username; CSRF guard; logout', async () => {
    const vercel = fakeVercel('tjones4701');
    const base = await start({ VERCEL_OAUTH_CLIENT_ID: 'cid', VERCEL_OAUTH_CLIENT_SECRET: 'csecret', UAS_SESSION_SECRET: 'x'.repeat(64), UAS_PUBLIC_URL: PUBLIC, UAS_ADMIN_VERCEL_USERS: 'tjones4701' }, vercel.fn);

    const login = await fetch(`${base}/auth/login?returnTo=/worlds`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const to = new URL(login.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://vercel.com/oauth/authorize');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: 'cid', redirect_uri: `${PUBLIC}/api/auth/callback`, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256',
    });
    const flowCookie = cookiesOf(login);
    expect(login.headers.getSetCookie()[0]).toMatch(/HttpOnly; SameSite=Lax/);
    vercel.setNonce(to.searchParams.get('nonce')!);

    // A forged state is refused.
    const bad = await fetch(`${base}/auth/callback?code=c&state=wrong`, { redirect: 'manual', headers: { cookie: flowCookie } });
    expect(bad.headers.get('location')).toBe(`${PUBLIC}/?authError=state%20mismatch`);

    const cb = await fetch(`${base}/auth/callback?code=the-code&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: flowCookie } });
    expect(cb.headers.get('location')).toBe(`${PUBLIC}/worlds`);
    const token = vercel.calls.find((c) => c.url.endsWith('/token'))!;
    expect(Object.fromEntries(new URLSearchParams(token.body))).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'cid', redirect_uri: `${PUBLIC}/api/auth/callback` });
    expect(new URLSearchParams(token.body).get('code_verifier')!.length).toBeGreaterThan(40);
    expect(vercel.calls.some((c) => c.url.endsWith('/revoke') && c.auth?.startsWith('Basic '))).toBe(true);
    const session = cookiesOf(cb).split('; ').find((c) => c.startsWith('uas_session='))!;
    expect(session).not.toContain('vercel-access');

    const me = await (await fetch(`${base}/auth/me`, { headers: { cookie: session } })).json();
    expect(me).toEqual({ user: { id: 'user_123', name: 'Test User', email: 't@example.com', avatarUrl: 'https://example.com/a.png', username: 'tjones4701' }, role: 'admin', loginAvailable: true });

    // Cookie-authenticated mutation: refused cross-site, allowed from our own origin.
    expect((await fetch(`${base}/worlds/nope/characters/robot/poke`, { method: 'POST', headers: { cookie: session } })).status).toBe(403);
    expect((await fetch(`${base}/worlds/nope/characters/robot/poke`, { method: 'POST', headers: { cookie: session, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/worlds/nope/characters/robot/poke`, { method: 'POST', headers: { cookie: session, origin: PUBLIC } })).status).toBe(404); // passed auth; no such world
    // API keys keep working alongside, with no Origin needed.
    expect((await fetch(`${base}/worlds/nope/characters/robot/poke`, { method: 'POST', headers: { authorization: 'Bearer admin-key' } })).status).toBe(404);

    // A tampered cookie is just anonymous.
    expect(((await (await fetch(`${base}/auth/me`, { headers: { cookie: `${session}x` } })).json()) as { role: string }).role).toBe('spectator');

    const out = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie: session, origin: PUBLIC } });
    expect(out.status).toBe(200);
    expect(((await (await fetch(`${base}/auth/me`, { headers: { cookie: session } })).json()) as { role: string }).role).toBe('spectator');
  });

  it('other Vercel users are visitors; returnTo cannot redirect off-site', async () => {
    const vercel = fakeVercel('someone-else');
    const base = await start({ VERCEL_OAUTH_CLIENT_ID: 'cid', UAS_SESSION_SECRET: 'y'.repeat(64), UAS_PUBLIC_URL: PUBLIC, UAS_ADMIN_VERCEL_USERS: 'tjones4701' }, vercel.fn);
    const login = await fetch(`${base}/auth/login?returnTo=//evil.example`, { redirect: 'manual' });
    const to = new URL(login.headers.get('location')!);
    vercel.setNonce(to.searchParams.get('nonce')!);
    const cb = await fetch(`${base}/auth/callback?code=c&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cookiesOf(login) } });
    expect(cb.headers.get('location')).toBe(`${PUBLIC}/`);
    const me = (await (await fetch(`${base}/auth/me`, { headers: { cookie: cookiesOf(cb) } })).json()) as { role: string };
    expect(me.role).toBe('visitor');
  });
});
