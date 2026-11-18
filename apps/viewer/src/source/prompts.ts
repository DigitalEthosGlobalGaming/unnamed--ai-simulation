/**
 * Prompt templates over REST (docs/architecture/prompts.md), admin only. Same origin through the
 * Vite `/api` proxy so the sign-in cookie rides along; an `?key=` API key is sent too.
 */
import {
  VisitorError,
  type PromptBody,
  type PromptPreview,
  type PromptSituation,
  type PromptSource,
  type PromptSummary,
  type PromptTemplate,
  type PromptTestEstimate,
  type PromptTestStatus,
  type PromptValidation,
  type PromptVersion,
  type PromptsApi,
  type WorldPrompts,
} from '../types.ts';

export class RestPrompts implements PromptsApi {
  private readonly base: string;

  constructor(
    base: string,
    private readonly worldId: () => string | undefined,
    private readonly apiKey?: string,
  ) {
    this.base = base.replace(/\/$/, '');
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
      const e = (data ?? {}) as { error?: string; errors?: { part?: string; path?: string; message: string }[] };
      const msg = e.error ?? e.errors?.map((x) => `${x.part ?? x.path ?? ''}: ${x.message}`).join('; ') ?? (res.status === 404 ? 'not available on this server yet' : res.statusText);
      throw new VisitorError(res.status, msg, (e.errors ?? []).map((x) => ({ path: x.part ?? x.path ?? '', message: x.message })));
    }
    return data as T;
  }

  private t(tid: string) {
    return `/prompts/${encodeURIComponent(tid)}`;
  }

  list = () => this.req<PromptSummary[]>('GET', '/prompts');
  get = (tid: string) => this.req<PromptTemplate>('GET', this.t(tid));
  version = (tid: string, v: number) => this.req<PromptVersion>('GET', `${this.t(tid)}/versions/${v}`);
  save = (tid: string, body: PromptBody, note: string) => this.req<{ version: number }>('POST', `${this.t(tid)}/versions`, { body, note });
  validate = (tid: string, body: PromptBody) => this.req<PromptValidation>('POST', `${this.t(tid)}/validate`, { body });
  preview = (tid: string, src: PromptSource, situation: string) => this.req<PromptPreview>('POST', `${this.t(tid)}/preview`, { ...src, situation });
  situations = () => this.req<PromptSituation[]>('GET', '/prompts/situations');
  estimate = (tid: string, src: PromptSource, situations?: string[]) => this.req<PromptTestEstimate>('POST', `${this.t(tid)}/test`, { ...src, ...(situations && { situations }) });
  startTest = (tid: string, src: PromptSource, situations?: string[]) => this.req<{ testId: string }>('POST', `${this.t(tid)}/test`, { ...src, ...(situations && { situations }), confirm: true });
  test = (testId: string) => this.req<PromptTestStatus>('GET', `/prompts/tests/${encodeURIComponent(testId)}`);
  world = () => this.req<WorldPrompts>('GET', `/worlds/${this.worldId()}/prompts`);
  activate = (tid: string, version: number) => this.req<{ active: Record<string, number> }>('POST', `/worlds/${this.worldId()}/prompts/${encodeURIComponent(tid)}/activate`, { version });
  rollback = (tid: string) => this.req<{ active: Record<string, number> }>('POST', `/worlds/${this.worldId()}/prompts/${encodeURIComponent(tid)}/rollback`);
}
