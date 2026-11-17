import { z } from 'zod';

/** One live-editable world setting, described so a UI can render it generically. */
export interface SettingField {
  key: SettingKey;
  label: string;
  kind: 'number' | 'boolean';
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help: string;
}

export const SettingsPatchSchema = z
  .strictObject({
    ticksPerRealSecond: z.number().min(0.25).max(20),
    moveSecondsPerTile: z.number().min(0.1).max(10),
    timeScale: z.number().min(0).max(100),
    paused: z.boolean(),
    dailyCapAud: z.number().min(0).max(100),
    energyPerAud: z.number().min(0).max(100_000),
    hostedModels: z.boolean(),
    needDecayMultiplier: z.number().min(0).max(10),
    escalateBelow: z.number().min(0).max(1),
  })
  .partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type SettingKey = keyof SettingsPatch;
export type SettingsValues = Required<SettingsPatch>;

/** Settings that persist across restarts (re-applied from logged `settings.change` events). Pause and speed are session-level. */
export const PERSISTED: SettingKey[] = ['ticksPerRealSecond', 'moveSecondsPerTile', 'dailyCapAud', 'energyPerAud', 'hostedModels', 'needDecayMultiplier', 'escalateBelow'];

export const SETTINGS_SCHEMA: SettingField[] = [
  {
    key: 'ticksPerRealSecond',
    label: 'Tick rate',
    kind: 'number',
    unit: 'ticks/s',
    min: 0.25,
    max: 20,
    step: 0.25,
    help: 'Simulation steps per real second. In a real-time world the in-world seconds per tick adjust so one in-world second still passes per real second; higher is smoother, not faster.',
  },
  {
    key: 'moveSecondsPerTile',
    label: 'Walking speed',
    kind: 'number',
    unit: 's/tile',
    min: 0.1,
    max: 10,
    step: 0.05,
    help: 'In-world seconds a robot takes to cross one tile.',
  },
  {
    key: 'timeScale',
    label: 'Time scale',
    kind: 'number',
    unit: '×',
    min: 0,
    max: 100,
    step: 0.5,
    help: 'Speed-up for development. A real-time world snaps back to the wall clock when this returns to 1.',
  },
  { key: 'paused', label: 'Paused', kind: 'boolean', help: 'Stop the clock. A real-time world catches up with the wall clock on resume (logged jump).' },
  {
    key: 'dailyCapAud',
    label: 'Daily spend cap',
    kind: 'number',
    unit: 'A$/day',
    min: 0,
    max: 100,
    step: 0.05,
    help: 'Real money this world may spend on hosted models per day. When it is reached, decisions use local models, then autopilot.',
  },
  {
    key: 'energyPerAud',
    label: 'Energy rate',
    kind: 'number',
    unit: 'battery per A$',
    min: 0,
    max: 100_000,
    step: 1,
    help: 'How much battery each A$ of thinking costs (1 = a full battery). It sets how much thinking a robot can afford: it can only think as much as its battery allows.',
  },
  { key: 'hostedModels', label: 'Hosted models', kind: 'boolean', help: 'Use hosted models through AI Gateway (needs AI_GATEWAY_API_KEY). Off: local models and autopilot only.' },
  {
    key: 'needDecayMultiplier',
    label: 'Need decay',
    kind: 'number',
    unit: '×',
    min: 0,
    max: 10,
    step: 0.1,
    help: 'Multiplier on how fast needs (cool, signal, curiosity) run down. Battery drain is unchanged.',
  },
  {
    key: 'escalateBelow',
    label: 'Escalate below',
    kind: 'number',
    unit: 'confidence',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'Decisions less confident than this are asked again of a stronger model (Jev), then planned.',
  },
];
