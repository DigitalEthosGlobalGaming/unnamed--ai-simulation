/**
 * Catalogue, airdrops and the mailbox over REST (docs/architecture/visitors.md), same origin
 * through the Vite `/api` proxy so the sign-in cookie rides along; an `?key=` API key is sent too.
 */
import { VisitorError, type Airdrop, type AirdropDetail, type CatalogItem, type MailStatus, type MailView, type ValidateResult, type Vec2, type VisitorApi } from '../types.ts';

export class RestVisitors implements VisitorApi {
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
      const e = (data ?? {}) as { error?: string; errors?: { path: string; message: string }[]; retryAfterSeconds?: number };
      const retry = e.retryAfterSeconds ?? (Number(res.headers.get('retry-after')) || undefined);
      const msg = e.error ?? e.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') ?? (res.status === 404 ? 'not available on this server yet' : res.statusText);
      throw new VisitorError(res.status, msg, e.errors ?? [], retry);
    }
    return data as T;
  }

  private w(path: string) {
    return `/worlds/${this.worldId()}${path}`;
  }

  catalog = () => this.req<CatalogItem[]>('GET', '/catalog');
  templates = () => this.req<{ name: string; item: CatalogItem }[]>('GET', '/catalog/templates');
  validate = (item: unknown) => this.req<ValidateResult>('POST', '/catalog/validate', { item });
  saveItem = (item: CatalogItem, disabled?: boolean) => this.req<CatalogItem>('PUT', `/catalog/${encodeURIComponent(item.id)}`, { item, ...(disabled !== undefined && { disabled }) });
  deleteItem = async (itemId: string) => {
    await this.req('DELETE', `/catalog/${encodeURIComponent(itemId)}`);
  };
  airdrops = () => this.req<Airdrop[]>('GET', this.w('/airdrops'));
  airdrop = (dropId: string) => this.req<AirdropDetail>('GET', this.w(`/airdrops/${encodeURIComponent(dropId)}`));
  drop = (itemId: string, pos: Vec2) => this.req<Airdrop>('POST', this.w('/airdrops'), { itemId, pos });
  removeDrop = async (dropId: string) => {
    await this.req('DELETE', this.w(`/airdrops/${encodeURIComponent(dropId)}`));
  };
  mail = () => this.req<MailView>('GET', this.w('/mail'));
  postMail = (text: string) => this.req<MailStatus>('POST', this.w('/mail'), { text });
  deleteMail = async (mailId: string) => {
    await this.req('DELETE', this.w(`/mail/${encodeURIComponent(mailId)}`));
  };
}
