/**
 * Sign in with Vercel and world settings over the server's REST API (same origin through the
 * Vite `/api` proxy, so the session cookie rides along). An `?key=` API key, when given, is sent
 * too, so key-based admin access keeps working.
 */
import { SettingsError, type AccountApi, type AuthState, type SettingField, type SettingValue, type WorldSettings } from '../types.ts';

export class RestAccount implements AccountApi {
  private readonly base: string;
  private readonly apiKey: string | undefined;
  private readonly worldId: () => string | undefined;

  constructor(base: string, worldId: () => string | undefined, apiKey?: string) {
    this.base = base.replace(/\/$/, '');
    this.worldId = worldId;
    this.apiKey = apiKey;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      credentials: 'include',
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(this.apiKey && { authorization: `Bearer ${this.apiKey}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; field?: string };
      throw new SettingsError(res.status, e.error ?? res.statusText, e.field);
    }
    return data as T;
  }

  async me(): Promise<AuthState> {
    try {
      const me = await this.req<{ user: { id: string; name: string | null; email: string | null; avatarUrl: string | null; username: string | null } | null; role: AuthState['role']; loginAvailable: boolean }>('GET', '/auth/me');
      const u = me.user;
      return {
        role: me.role,
        loginAvailable: me.loginAvailable,
        user: u ? { id: u.id, name: u.name ?? u.username ?? u.email ?? 'Signed in', email: u.email ?? '', avatarUrl: u.avatarUrl } : null,
      };
    } catch (e) {
      // A server without accounts yet: anonymous spectator (or admin by key, which the server will report once /auth/me exists).
      if (e instanceof SettingsError && e.status === 404) return { user: null, role: 'spectator', loginAvailable: false };
      throw e;
    }
  }

  /** `returnTo` is a path on this site; the server sends the browser back to its public URL + path. */
  login(returnTo: string): void {
    const u = new URL(returnTo, location.href);
    u.searchParams.delete('authError');
    location.href = `${this.base}/auth/login?returnTo=${encodeURIComponent(u.pathname + u.search)}`;
  }

  async logout(): Promise<void> {
    await this.req('POST', '/auth/logout', {});
  }

  private schema: WorldSettings['schema'] = {};

  /** The server lists the schema as an array in display order; the viewer keys it by field. */
  async settings(): Promise<WorldSettings> {
    const raw = await this.req<{ values: WorldSettings['values']; schema: (SettingField & { key: string })[] | WorldSettings['schema']; derived: WorldSettings['derived'] }>('GET', `/worlds/${this.worldId()}/settings`);
    this.schema = Array.isArray(raw.schema) ? Object.fromEntries(raw.schema.map(({ key, ...f }) => [key, f])) : raw.schema;
    return { values: raw.values, schema: this.schema, derived: raw.derived };
  }

  /** PATCH returns `{ values, derived, effects }`; the schema doesn't change, so the last one is kept. */
  async updateSettings(patch: Record<string, SettingValue>): Promise<WorldSettings> {
    const out = await this.req<{ values: WorldSettings['values']; derived: WorldSettings['derived']; effects?: string[] }>('PATCH', `/worlds/${this.worldId()}/settings`, patch);
    return { values: out.values, schema: this.schema, derived: out.derived, ...(out.effects && { effects: out.effects }) };
  }
}
