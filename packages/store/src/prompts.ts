import Database from 'better-sqlite3';
import { and, asc, eq } from 'drizzle-orm';
import type { Json } from '@uas/core';
import type { Db } from './sqlite.ts';
import * as schema from './schema.ts';

export interface PromptVersionRow {
  templateId: string;
  version: number;
  body: { parts: Record<string, string> };
  note: string;
  createdAt: string;
  createdBy: string;
}

/**
 * Prompt template versions (docs/architecture/prompts.md): server-wide, immutable, numbered per
 * template from 1. Version 1 of each is seeded from the repo default on first open.
 */
export class PromptVersions {
  private readonly db: Db;
  constructor(db: Db, defaults: Record<string, { parts: Record<string, string> }>) {
    this.db = db;
    const now = new Date().toISOString();
    for (const [templateId, body] of Object.entries(defaults)) {
      this.db
        .insert(schema.promptVersions)
        .values({ templateId, version: 1, body: body as unknown as Json, note: 'repo default', createdAt: now, createdBy: 'repo' })
        .onConflictDoNothing()
        .run();
    }
  }

  versions(templateId: string): PromptVersionRow[] {
    return this.db
      .select()
      .from(schema.promptVersions)
      .where(eq(schema.promptVersions.templateId, templateId))
      .orderBy(asc(schema.promptVersions.version))
      .all() as PromptVersionRow[];
  }

  get(templateId: string, version: number): PromptVersionRow | undefined {
    return this.db
      .select()
      .from(schema.promptVersions)
      .where(and(eq(schema.promptVersions.templateId, templateId), eq(schema.promptVersions.version, version)))
      .get() as PromptVersionRow | undefined;
  }

  latest(templateId: string): number {
    return this.versions(templateId).at(-1)?.version ?? 0;
  }

  /** A new version (the next number); versions are never edited. */
  create(templateId: string, body: { parts: Record<string, string> }, note: string, by: string): PromptVersionRow {
    return this.db.transaction((tx) => {
      const last = tx
        .select({ v: schema.promptVersions.version })
        .from(schema.promptVersions)
        .where(eq(schema.promptVersions.templateId, templateId))
        .all()
        .reduce((m, r) => Math.max(m, r.v), 0);
      const row: PromptVersionRow = { templateId, version: last + 1, body, note, createdAt: new Date().toISOString(), createdBy: by };
      tx.insert(schema.promptVersions).values({ ...row, body: body as unknown as Json }).run();
      return row;
    });
  }
}

/** One stored version, read-only (scripts reading a server database that may be in use). */
export function readPromptVersion(path: string, templateId: string, version: number): PromptVersionRow | undefined {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hasTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prompt_versions'").get();
    if (!hasTable) return undefined;
    const r = sqlite.prepare('SELECT template_id, version, body, note, created_at, created_by FROM prompt_versions WHERE template_id = ? AND version = ?').get(templateId, version) as
      | { template_id: string; version: number; body: string; note: string; created_at: string; created_by: string }
      | undefined;
    return r && { templateId: r.template_id, version: r.version, body: JSON.parse(r.body) as PromptVersionRow['body'], note: r.note, createdAt: r.created_at, createdBy: r.created_by };
  } finally {
    sqlite.close();
  }
}
