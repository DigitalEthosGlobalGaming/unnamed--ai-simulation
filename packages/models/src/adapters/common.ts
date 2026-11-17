import type { Usage } from '@uas/core';
import type { TokenCounts } from '../types.ts';

export type Pricer = (modelId: string, t: TokenCounts) => Usage;
export type Fetch = typeof fetch;

export async function postJson<T>(fetchFn: Fetch, url: string, body: unknown, signal?: AbortSignal, apiKey?: string): Promise<T> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify(body),
    ...(signal && { signal }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** Five-level scale used for `score` jobs; value = level / 4. */
export const SCORE_LEVELS = ['very low / very bad', 'low / bad', 'middling / neutral', 'high / good', 'very high / very good'];
