import type { Json } from '@uas/core';

/** Per-world mind settings. Stored in `WorldState.ext.mind` so snapshots and replays carry them. */
export interface MindConfig {
  /** 'autopilot' never asks a model (M3); 'models' dispatches jobs to the gateway. */
  brain: 'autopilot' | 'models';
  /** Energy charged per AUD of model cost. TODO(open question): provisional default. */
  energyPerAud: number;
  /** After hitting 0, only autopilot runs until energy is back above this. */
  energyFloor: number;
  /** Ticks to wait for a model answer before falling back. */
  jobTimeoutTicks: number;
  /** Ask models to appraise and score each outcome (two cheap jobs per outcome). */
  appraiseOutcomes: boolean;
  /** Visitor queue tuning (open question in the spec; provisional defaults). */
  visitorQueue: { maxLength: number; ttlTicks: number; cooldownTicks: number };
}

export const DEFAULT_MIND_CONFIG: MindConfig = {
  brain: 'autopilot',
  energyPerAud: 2,
  energyFloor: 0.1,
  jobTimeoutTicks: 100,
  appraiseOutcomes: true,
  visitorQueue: { maxLength: 5, ttlTicks: 1200, cooldownTicks: 150 },
};

export function mindConfigOf(ext: Record<string, Json>): MindConfig {
  const m = (ext.mind ?? {}) as Partial<MindConfig>;
  return { ...DEFAULT_MIND_CONFIG, ...m, visitorQueue: { ...DEFAULT_MIND_CONFIG.visitorQueue, ...m.visitorQueue } };
}
