import type { JobName, Usage } from '@uas/core';
import type { TokenCounts } from './types.ts';

/** Prices in USD per million tokens, as providers publish them. */
export interface Price {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Cost in AUD: audPerUsd · (t_in·p_in + t_cached·p_cached + t_out·p_out).
 * `inputTokens` is uncached input only. The rate is config, never fetched, so replays agree.
 */
export function priceUsage(modelId: string, t: TokenCounts, price: Price, audPerUsd: number): Usage {
  const usd = t.costUsd ?? (t.inputTokens * price.inputPerMTok + t.cachedInputTokens * price.cachedInputPerMTok + t.outputTokens * price.outputPerMTok) / 1e6;
  const { costUsd: _ignored, ...counts } = t;
  return { ...counts, costAud: Math.round(usd * audPerUsd * 1e8) / 1e8, modelId };
}

export interface UsageRow {
  day: string;
  modelId: string;
  job: JobName;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costAud: number;
  energy: number;
}

/** Totals by (real day, model, job) for `GET /usage` and the daily AUD cap. */
export class CostMeter {
  private rows = new Map<string, UsageRow>();
  private readonly today: () => string;
  /** Called after every record, e.g. to persist the row so the daily cap survives a restart. */
  onRecord: ((row: UsageRow) => void) | undefined;

  constructor(today: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.today = today;
  }

  /** Load rows recorded before a restart. */
  seed(rows: UsageRow[]): void {
    for (const r of rows) this.rows.set(`${r.day}|${r.modelId}|${r.job}`, { ...r });
  }

  currentDay(): string {
    return this.today();
  }

  record(job: JobName, usage: Usage, energy: number): void {
    const day = this.today();
    const key = `${day}|${usage.modelId}|${job}`;
    const row = this.rows.get(key) ?? { day, modelId: usage.modelId, job, calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costAud: 0, energy: 0 };
    row.calls++;
    row.inputTokens += usage.inputTokens;
    row.cachedInputTokens += usage.cachedInputTokens;
    row.outputTokens += usage.outputTokens;
    row.costAud += usage.costAud;
    row.energy += energy;
    this.rows.set(key, row);
    this.onRecord?.(row);
  }

  spentTodayAud(): number {
    const day = this.today();
    return [...this.rows.values()].filter((r) => r.day === day).reduce((a, r) => a + r.costAud, 0);
  }

  report(day?: string): UsageRow[] {
    return [...this.rows.values()].filter((r) => !day || r.day === day);
  }
}
