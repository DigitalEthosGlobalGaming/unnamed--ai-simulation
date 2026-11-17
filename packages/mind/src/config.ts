import type { Json } from '@uas/core';

/** Per-world mind settings. Stored in `WorldState.ext.mind` so snapshots and replays carry them. */
export interface MindConfig {
  /** 'autopilot' never asks a model (M3); 'models' dispatches jobs to the gateway. */
  brain: 'autopilot' | 'models';
  /** Battery drained per AUD of model cost: 5 means a full battery is A$0.20 of thinking (decision 45). */
  energyPerAud: number;
  /** Legacy (iteration 1); the empty band is now `batteryHabitAbove`. */
  energyFloor: number;
  /** Ticks to wait for a model answer before falling back. */
  jobTimeoutTicks: number;
  /** Ask models to appraise and score each outcome (two cheap jobs per outcome). */
  appraiseOutcomes: boolean;
  /** Multiplier on need decay (not battery drain); a live world setting. */
  needDecayMultiplier: number;
  /** Thinking tiers by battery (iteration 2): at or above → plan model allowed, → decision model, → habits; below the last, autopilot only. */
  batteryPlanAbove: number;
  batteryGutAbove: number;
  batteryHabitAbove: number;
}

export const DEFAULT_MIND_CONFIG: MindConfig = {
  brain: 'autopilot',
  energyPerAud: 5,
  energyFloor: 0.1,
  jobTimeoutTicks: 100,
  appraiseOutcomes: true,
  needDecayMultiplier: 1,
  batteryPlanAbove: 0.6,
  batteryGutAbove: 0.3,
  batteryHabitAbove: 0.05,
};

export function mindConfigOf(ext: Record<string, Json>): MindConfig {
  const m = (ext.mind ?? {}) as Partial<MindConfig>;
  return { ...DEFAULT_MIND_CONFIG, ...m };
}
