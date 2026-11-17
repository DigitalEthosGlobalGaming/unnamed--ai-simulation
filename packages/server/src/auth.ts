import { createHash, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'visitor' | 'spectator';
export interface Principal {
  role: Role;
  /** Stable id for a key (hash prefix); visitors are bound to one visitor per world by it. */
  keyId?: string;
  /** Public name for visitor actions (the Vercel username for signed-in users). */
  username?: string;
}

const RANK: Record<Role, number> = { spectator: 0, visitor: 1, admin: 2 };

/**
 * API keys from configuration (v1). `UAS_ADMIN_KEYS` and `UAS_VISITOR_KEYS` are comma-separated.
 * Keys are kept only as SHA-256 hashes in memory.
 */
export class KeyRing {
  private readonly keys = new Map<string, Role>();

  constructor(keys: { key: string; role: Role }[]) {
    for (const k of keys) if (k.key) this.keys.set(hash(k.key), k.role);
  }

  static fromEnv(env: Record<string, string | undefined>): KeyRing {
    const split = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return new KeyRing([
      ...split(env.UAS_ADMIN_KEYS).map((key) => ({ key, role: 'admin' as const })),
      ...split(env.UAS_VISITOR_KEYS).map((key) => ({ key, role: 'visitor' as const })),
      ...split(env.UAS_SPECTATOR_KEYS).map((key) => ({ key, role: 'spectator' as const })),
    ]);
  }

  /** Undefined key = anonymous; an unknown key is rejected (null). */
  identify(key: string | undefined): Principal | null | undefined {
    if (!key) return undefined;
    const h = hash(key);
    for (const [k, role] of this.keys) {
      if (timingSafeEqual(Buffer.from(k), Buffer.from(h))) return { role, keyId: h.slice(0, 16) };
    }
    return null;
  }
}

export const allows = (p: Principal | undefined, need: Role, publicRead: boolean) =>
  need === 'spectator' && !p ? publicRead : !!p && RANK[p.role] >= RANK[need];

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
