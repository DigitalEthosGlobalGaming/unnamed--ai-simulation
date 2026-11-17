/**
 * Visitor-facing state: items airdropped into the world, the mailbox, and the catalogue. Kept
 * fresh by polling (lightly) and by the world's `airdrop` / `mailbox` deltas.
 */
import type { Airdrop, CatalogItem, MailView, VisitorApi } from '../types.ts';

const POLL_MS = 10_000;

export class VisitorStore {
  airdrops: Airdrop[] = [];
  mail: MailView | null = null;
  catalogue: CatalogItem[] = [];
  /** Why the server's visitor endpoints can't be used, if they can't (e.g. not built yet). */
  unavailable = '';
  private listeners = new Set<() => void>();
  private timer: number | undefined;
  private pending: number | undefined;

  constructor(readonly api: VisitorApi | undefined) {}

  on(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  start() {
    void this.refresh();
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Coalesce bursts (several deltas in a row) into one refresh. */
  soon() {
    if (this.pending !== undefined) return;
    this.pending = window.setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, 300);
  }

  async refresh() {
    if (!this.api) {
      this.unavailable = 'This data source has no visitors.';
      return this.notify();
    }
    const [drops, mail, cat] = await Promise.allSettled([this.api.airdrops(), this.api.mail(), this.api.catalog()]);
    if (drops.status === 'fulfilled') this.airdrops = drops.value;
    if (mail.status === 'fulfilled') this.mail = mail.value;
    if (cat.status === 'fulfilled') this.catalogue = cat.value;
    const failed = [drops, mail, cat].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    this.unavailable = failed ? String((failed.reason as Error).message ?? failed.reason) : '';
    this.notify();
  }

  drop(id: string): Airdrop | undefined {
    return this.airdrops.find((d) => d.id === id);
  }

  get waiting(): number {
    return this.mail?.waiting ?? 0;
  }
}
