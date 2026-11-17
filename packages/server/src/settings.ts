import { z } from 'zod';
import { DEFAULT_LIMITS, UNLIMITED, type VisitorLimits } from './visitors.ts';

/** One live-editable world setting, described so a UI can render it generically. */
export interface SettingField {
  key: SettingKey;
  label: string;
  /** `string[]`: a list of catalogue item ids (`*` = all). */
  kind: 'number' | 'boolean' | 'string[]';
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
    batteryPlanAbove: z.number().min(0).max(1),
    batteryGutAbove: z.number().min(0).max(1),
    batteryHabitAbove: z.number().min(0).max(1),
    /** One-shot: add this much battery to every robot now (a logged admin edit). Reads back 0. */
    batteryTopUp: z.number().min(0).max(1),
    escalateBelow: z.number().min(0).max(1),
    catalogEnabled: z.array(z.string().regex(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)*)$/, 'an item id or *')).max(1000),
    airdropMaxActivePerVisitor: z.int().min(0).max(UNLIMITED),
    airdropCooldownSeconds: z.number().min(0).max(30 * 86_400),
    airdropWorldCap: z.int().min(0).max(UNLIMITED),
    airdropDefaultExpiry: z.number().min(0).max(365 * 86_400),
    mailCapacity: z.int().min(0).max(UNLIMITED),
    mailExpirySeconds: z.number().min(0).max(365 * 86_400),
    mailMaxWaitingPerVisitor: z.int().min(0).max(UNLIMITED),
    mailCooldownSeconds: z.number().min(0).max(30 * 86_400),
  })
  .partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type SettingKey = keyof SettingsPatch;
export type SettingsValues = Required<SettingsPatch>;

/** Settings that persist across restarts (re-applied from logged `settings.change` events). Pause and speed are session-level. */
export const PERSISTED: SettingKey[] = [
  'ticksPerRealSecond',
  'moveSecondsPerTile',
  'dailyCapAud',
  'energyPerAud',
  'hostedModels',
  'needDecayMultiplier',
  'batteryPlanAbove',
  'batteryGutAbove',
  'batteryHabitAbove',
  'escalateBelow',
  ...(Object.keys(DEFAULT_LIMITS) as (keyof VisitorLimits)[]),
];

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
  ...band('batteryPlanAbove', 'Think it through above', 'With the battery at or above this, the robot may use the plan model (think it through).'),
  ...band('batteryGutAbove', 'Gut calls above', 'At or above this (and below the line above), the decision model only (gut calls).'),
  ...band('batteryHabitAbove', 'Habits above', 'At or above this, habits and autopilot; below it, autopilot only until the robot sleeps.'),
  {
    key: 'batteryTopUp',
    label: 'Top up battery',
    kind: 'number',
    unit: 'battery',
    min: 0,
    max: 1,
    step: 0.05,
    help: 'One-shot: adds this much battery (1 = a full battery) to every robot now, as a logged admin edit. Only sleep recharges it otherwise. Reads back 0.',
  },
  {
    key: 'catalogEnabled',
    label: 'Airdrop items',
    kind: 'string[]',
    help: 'Catalogue item ids visitors may drop in this world; * enables every item.',
  },
  ...limit('airdropMaxActivePerVisitor', 'Drops per visitor', 'items', 'How many of one visitor\'s drops may be in the world at once.'),
  ...seconds('airdropCooldownSeconds', 'Drop cooldown', 'Real seconds a visitor waits between drops. Admins are not limited.'),
  ...limit('airdropWorldCap', 'Drops in the world', 'items', 'How many dropped items the world holds at once.'),
  ...seconds('airdropDefaultExpiry', 'Drop expiry', 'In-world seconds before a dropped item without its own expiry disappears; 0 = never.'),
  ...limit('mailCapacity', 'Mailbox capacity', 'messages', 'Messages that may wait in the mailbox at once.'),
  ...seconds('mailExpirySeconds', 'Mail expiry', 'In-world seconds a message may wait unread before it expires; 0 = never.'),
  ...limit('mailMaxWaitingPerVisitor', 'Mail per visitor', 'messages', 'Unread messages one visitor may have waiting.'),
  ...seconds('mailCooldownSeconds', 'Mail cooldown', 'Real seconds a visitor waits between messages. Admins are not limited.'),
];

function limit(key: SettingKey, label: string, unit: string, help: string): SettingField[] {
  return [{ key, label, kind: 'number', unit, min: 0, max: UNLIMITED, step: 1, help: `${help} Admins are not limited.` }];
}
function seconds(key: SettingKey, label: string, help: string): SettingField[] {
  return [{ key, label, kind: 'number', unit: 's', min: 0, max: 365 * 86_400, step: 1, help }];
}
function band(key: SettingKey, label: string, help: string): SettingField[] {
  return [{ key, label, kind: 'number', unit: 'battery', min: 0, max: 1, step: 0.05, help: `${help} Thinking tiers step down as the battery falls.` }];
}
