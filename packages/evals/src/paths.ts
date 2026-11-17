import { resolve } from 'node:path';

/** Repository paths for situations, golden prompts and reports. */
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const SITUATIONS_DIR = resolve(REPO_ROOT, 'evals/situations');
export const PROMPTS_DIR = resolve(REPO_ROOT, 'evals/prompts');
export const REPORTS_DIR = resolve(REPO_ROOT, 'docs/benchmarks/evals');
