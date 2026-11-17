import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Express, Request, Response } from 'express';
import { schema, type Db } from '@uas/store';
import type { Principal, Role } from './auth.ts';

/** Sign in with Vercel endpoints (https://vercel.com/docs/sign-in-with-vercel/getting-started). */
const AUTHORIZE_URL = 'https://vercel.com/oauth/authorize';
const TOKEN_URL = 'https://api.vercel.com/login/oauth/token';
const USERINFO_URL = 'https://api.vercel.com/login/oauth/userinfo';
const REVOKE_URL = 'https://api.vercel.com/login/oauth/token/revoke';
const SESSION_COOKIE = 'uas_session';
const OAUTH_COOKIE = 'uas_oauth';
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  name: string | null;
  email: string | null;
  username: string | null;
  avatarUrl: string | null;
}

export interface AuthEnv {
  VERCEL_OAUTH_CLIENT_ID?: string | undefined;
  VERCEL_OAUTH_CLIENT_SECRET?: string | undefined;
  UAS_SESSION_SECRET?: string | undefined;
  UAS_PUBLIC_URL?: string | undefined;
  UAS_ADMIN_VERCEL_USERS?: string | undefined;
}

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Sign in with Vercel (OAuth 2.0 / OIDC, authorization code + PKCE S256, state and nonce).
 * The browser gets only a signed, httpOnly session id; users live in SQLite. Vercel's tokens are
 * used once to read the profile and then revoked. Without a client id, login is unavailable
 * and everything else keeps working (API keys, anonymous spectators).
 */
export class VercelAuth {
  private readonly db: Db;
  private readonly env: AuthEnv;
  private readonly fetchFn: typeof fetch;
  private readonly secret: string;
  readonly publicUrl: string;
  private readonly admins: Set<string>;

  constructor(db: Db, env: AuthEnv, fetchFn: typeof fetch = fetch) {
    this.db = db;
    this.env = env;
    this.fetchFn = fetchFn;
    // Without a configured secret (tests, misconfiguration) sessions only last this process.
    this.secret = env.UAS_SESSION_SECRET || randomBytes(32).toString('hex');
    this.publicUrl = (env.UAS_PUBLIC_URL || 'http://localhost:5173').replace(/\/$/, '');
    this.admins = new Set((env.UAS_ADMIN_VERCEL_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  }

  get loginAvailable(): boolean {
    return !!this.env.VERCEL_OAUTH_CLIENT_ID;
  }

  /** The callback Vercel redirects to: through the Vite `/api` proxy in dev. Register exactly this URL. */
  get redirectUri(): string {
    return `${this.publicUrl}/api/auth/callback`;
  }

  private get secure(): boolean {
    return this.publicUrl.startsWith('https://');
  }

  // ------------------------------------------------------------------ signed cookies

  private sign(value: string): string {
    return `${value}.${b64url(createHmac('sha256', this.secret).update(value).digest())}`;
  }

  private unsign(signed: string | undefined): string | undefined {
    if (!signed) return undefined;
    const i = signed.lastIndexOf('.');
    if (i < 0) return undefined;
    const value = signed.slice(0, i);
    const expected = Buffer.from(this.sign(value));
    const given = Buffer.from(signed);
    return expected.length === given.length && timingSafeEqual(expected, given) ? value : undefined;
  }

  private cookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (this.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  private readCookie(header: string | undefined, name: string): string | undefined {
    for (const part of (header ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return decodeURIComponent(v.join('='));
    }
    return undefined;
  }

  // ------------------------------------------------------------------ sessions

  /** The signed-in user for a request's cookies, or undefined. */
  sessionFor(cookieHeader: string | undefined): (SessionUser & { role: Role; sessionId: string }) | undefined {
    const id = this.unsign(this.readCookie(cookieHeader, SESSION_COOKIE));
    if (!id) return undefined;
    const row = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    if (!row || row.expiresAt < new Date().toISOString()) return undefined;
    return { sessionId: row.id, id: row.userId, name: row.name, email: row.email, username: row.username, avatarUrl: row.avatarUrl, role: row.role as Role };
  }

  /** A principal for the API's role checks; `keyId` binds a visitor character to this user. */
  principalFor(cookieHeader: string | undefined): (Principal & { viaCookie: true }) | undefined {
    const s = this.sessionFor(cookieHeader);
    return s && { role: s.role, keyId: `u${createHash('sha256').update(s.id).digest('hex').slice(0, 15)}`, username: s.username ?? s.name ?? 'visitor', viaCookie: true };
  }

  roleFor(user: { id: string; username: string | null }): Role {
    return this.admins.has(user.id) || (user.username !== null && this.admins.has(user.username)) ? 'admin' : 'visitor';
  }

  // ------------------------------------------------------------------ routes

  routes(app: Express): void {
    app.get('/auth/me', (req, res) => {
      const s = this.sessionFor(req.get('cookie'));
      res.json({
        user: s ? { id: s.id, name: s.name, email: s.email, avatarUrl: s.avatarUrl, username: s.username } : null,
        role: s?.role ?? 'spectator',
        loginAvailable: this.loginAvailable,
      });
    });

    app.get('/auth/login', (req, res) => {
      if (!this.loginAvailable) return void res.status(404).json({ error: 'Sign in with Vercel is not configured (VERCEL_OAUTH_CLIENT_ID)' });
      const returnTo = safeReturnTo(req.query.returnTo);
      const state = b64url(randomBytes(32));
      const nonce = b64url(randomBytes(32));
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      this.cookie(res, OAUTH_COOKIE, this.sign(b64url(Buffer.from(JSON.stringify({ state, nonce, verifier, returnTo })))), 600);
      const q = new URLSearchParams({
        client_id: this.env.VERCEL_OAUTH_CLIENT_ID!,
        redirect_uri: this.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      res.redirect(`${AUTHORIZE_URL}?${q}`);
    });

    app.get('/auth/callback', async (req: Request, res: Response) => {
      const fail = (why: string) => {
        this.cookie(res, OAUTH_COOKIE, '', 0);
        res.redirect(`${this.publicUrl}/?authError=${encodeURIComponent(why)}`);
      };
      try {
        if (!this.loginAvailable) return fail('login unavailable');
        if (typeof req.query.error === 'string') return fail(req.query.error);
        const raw = this.unsign(this.readCookie(req.get('cookie'), OAUTH_COOKIE));
        if (!raw) return fail('login expired, please try again');
        const flow = JSON.parse(Buffer.from(raw, 'base64url').toString()) as { state: string; nonce: string; verifier: string; returnTo: string };
        if (typeof req.query.state !== 'string' || req.query.state !== flow.state) return fail('state mismatch');
        if (typeof req.query.code !== 'string') return fail('missing code');

        const tokenRes = await this.fetchFn(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.env.VERCEL_OAUTH_CLIENT_ID!,
            client_secret: this.env.VERCEL_OAUTH_CLIENT_SECRET ?? '',
            code: req.query.code,
            code_verifier: flow.verifier,
            redirect_uri: this.redirectUri,
          }),
        });
        if (!tokenRes.ok) return fail(`token exchange failed (HTTP ${tokenRes.status})`);
        const tokens = (await tokenRes.json()) as { access_token: string; id_token?: string };
        const claims = tokens.id_token ? (JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString()) as { nonce?: string }) : {};
        if (claims.nonce !== flow.nonce) return fail('nonce mismatch');

        const infoRes = await this.fetchFn(USERINFO_URL, { headers: { authorization: `Bearer ${tokens.access_token}` } });
        if (!infoRes.ok) return fail(`userinfo failed (HTTP ${infoRes.status})`);
        const info = (await infoRes.json()) as { sub: string; name?: string; email?: string; preferred_username?: string; picture?: string };
        // We keep our own session; Vercel's token is no longer needed.
        void this.revoke(tokens.access_token);

        const user: SessionUser = { id: info.sub, name: info.name ?? null, email: info.email ?? null, username: info.preferred_username ?? null, avatarUrl: info.picture ?? null };
        const id = b64url(randomBytes(32));
        const now = new Date();
        this.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now.toISOString())).run();
        this.db
          .insert(schema.sessions)
          .values({
            id,
            userId: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
            role: this.roleFor(user),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
          })
          .run();
        this.cookie(res, OAUTH_COOKIE, '', 0);
        this.cookie(res, SESSION_COOKIE, this.sign(id), SESSION_DAYS * 86_400);
        res.redirect(`${this.publicUrl}${flow.returnTo}`);
      } catch {
        fail('sign-in failed');
      }
    });

    app.post('/auth/logout', (req, res) => {
      const s = this.sessionFor(req.get('cookie'));
      if (s) this.db.delete(schema.sessions).where(eq(schema.sessions.id, s.sessionId)).run();
      this.cookie(res, SESSION_COOKIE, '', 0);
      res.json({ ok: true });
    });
  }

  private async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.env.VERCEL_OAUTH_CLIENT_ID}:${this.env.VERCEL_OAUTH_CLIENT_SECRET ?? ''}`).toString('base64');
    await this.fetchFn(REVOKE_URL, { method: 'POST', headers: { authorization: `Basic ${basic}` }, body: new URLSearchParams({ token }) }).catch(() => undefined);
  }

  /**
   * CSRF guard for cookie-authenticated mutations: besides SameSite=Lax, the request's Origin
   * (or Referer) must be the public URL or this server itself. API-key requests are exempt.
   */
  sameOrigin(req: Request): boolean {
    const origin = req.get('origin') ?? (req.get('referer') ? new URL(req.get('referer')!).origin : undefined);
    if (!origin) return false;
    const self = `${req.protocol}://${req.get('host')}`;
    return origin === new URL(this.publicUrl).origin || origin === self;
  }
}

/** Only same-site relative paths, so login can't be used as an open redirect. */
function safeReturnTo(v: unknown): string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';
}
