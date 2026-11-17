import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mindConfigOf } from '@uas/mind';
import { WorldRuntime, parseWorldFile } from '../src/index.ts';

const config = () =>
  parseWorldFile({
    id: 'settingsworld',
    seed: 1,
    clock: { mode: 'realtime', timezone: 'UTC' },
    mind: { brain: 'autopilot' },
    entities: [{ id: 'robot', type: 'robot', pos: [10, 10] }],
    models: {
      dailyCapAud: 0.5,
      energyPerAud: 2,
      models: { laya: { adapter: 'gateway-decision', model: 'convaiinnovations/laya', apiKey: 'k', price: { inputPerMTok: 0.0105, cachedInputPerMTok: 0.0105, outputPerMTok: 0 } } },
      jobs: { decide: ['laya'] },
    },
  });

describe('live world settings', () => {
  it('describes every field for a generic UI and reports derived costs', () => {
    const rt = new WorldRuntime(config(), { dbPath: join(mkdtempSync(join(tmpdir(), 'uas-set-')), 'uas.db') });
    rt.start();
    const s = rt.settings();
    expect(s.schema.map((f) => f.key)).toEqual(['ticksPerRealSecond', 'moveSecondsPerTile', 'timeScale', 'paused', 'dailyCapAud', 'energyPerAud', 'hostedModels', 'needDecayMultiplier', 'escalateBelow',
      'batteryPlanAbove', 'batteryGutAbove', 'batteryHabitAbove', 'batteryTopUp',
      'catalogEnabled', 'airdropMaxActivePerVisitor', 'airdropCooldownSeconds', 'airdropWorldCap', 'airdropDefaultExpiry',
      'mailCapacity', 'mailExpirySeconds', 'mailMaxWaitingPerVisitor', 'mailCooldownSeconds']);
    for (const f of s.schema) expect(f.help.length).toBeGreaterThan(10);
    expect(s.values).toMatchObject({ ticksPerRealSecond: 4, moveSecondsPerTile: 0.75, dailyCapAud: 0.5, energyPerAud: 2, hostedModels: true });
    // 350 tokens of Laya at US$0.0105/M × 1.55 ≈ A$0.0000057 per decision; × 2 battery per A$.
    expect(s.derived.averageDecisionCostEstimated).toBe(true);
    expect(s.derived.batteryPerDecision).toBeCloseTo(350 * 0.0105e-6 * 1.55 * 2, 12);
    expect(s.derived.decisionsPerFullBattery).toBeGreaterThan(80_000);
    expect(s.derived.inWorldSecondsPerRealSecond).toBe(1);
  });

  it('applies changes live, logs them, keeps real time at 1×, and survives a restart', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'uas-set-')), 'uas.db');
    const rt = new WorldRuntime(config(), { dbPath });
    rt.start();
    rt.tick();
    const r = rt.applySettings({ ticksPerRealSecond: 8, moveSecondsPerTile: 0.5, energyPerAud: 1000, dailyCapAud: 0.2, hostedModels: false, needDecayMultiplier: 2 });
    // The response already reflects the change (applied by the sim on the next tick).
    expect(r.values).toMatchObject({ ticksPerRealSecond: 8, moveSecondsPerTile: 0.5, energyPerAud: 1000, needDecayMultiplier: 2 });
    expect(r.derived).toMatchObject({ secondsPerTick: 0.125, moveTicksPerTile: 4, inWorldSecondsPerRealSecond: 1 });
    rt.tick();
    expect(r.effects.some((e) => e.startsWith('sim timing'))).toBe(true);
    expect(rt.world.state.config).toMatchObject({ secondsPerTick: 0.125, moveTicksPerTile: 4, durationScale: 8 });
    expect(rt.status().inWorldSecondsPerRealSecond).toBe(1);
    expect(mindConfigOf(rt.world.state.ext)).toMatchObject({ energyPerAud: 1000, needDecayMultiplier: 2 });
    expect(rt.gateway.hostedEnabled).toBe(false);
    expect(rt.settings().derived.hostedModelsAvailable).toEqual(['laya']);
    const types = rt.log.read('settingsworld').map((e) => e.type);
    expect(types).toContain('settings.change');
    expect(types).toContain('sim.config');
    expect(() => rt.applySettings({ ticksPerRealSecond: 0 })).toThrow(/settings: ticksPerRealSecond/);
    expect(() => rt.applySettings({ bogus: 1 })).toThrow(/settings/);
    rt.shutdown();

    const again = new WorldRuntime(config(), { dbPath });
    again.start();
    again.tick();
    expect(again.settingsValues()).toMatchObject({ ticksPerRealSecond: 8, moveSecondsPerTile: 0.5, energyPerAud: 1000, dailyCapAud: 0.2, hostedModels: false, needDecayMultiplier: 2 });
    // No timing change on restart: the persisted tick rate matches the state.
    expect(again.log.read('settingsworld').filter((e) => e.type === 'sim.config')).toHaveLength(1);
  });
});
