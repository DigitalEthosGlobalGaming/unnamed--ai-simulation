/**
 * SIMULATED DATA. A stand-in for the server's accounts and world-settings endpoints, following
 * the agreed contract (`GET /auth/me`, `GET|PATCH /worlds/:id/settings`), so the viewer's sign-in
 * and settings UI can be built and reviewed offline. `?as=admin|visitor|spectator` picks the mock
 * role (default: signed out, with sign-in available); `?login=0` hides sign-in.
 */
import { SettingsError, type AccountApi, type AuthState, type SettingField, type WorldSettings } from '../types.ts';

const SCHEMA: Record<string, SettingField> = {
  paused: { label: 'Paused', kind: 'boolean', help: 'Stops the world clock. Replays and the plan still work.' },
  ticksPerRealSecond: { label: 'Tick rate', kind: 'number', unit: 'ticks/s', min: 0.2, max: 20, step: 0.1, help: 'How many simulation ticks run per real second.' },
  timeScale: { label: 'Time scale', kind: 'number', unit: '×', min: 0.1, max: 60, step: 0.1, help: 'Speeds the world up or down relative to the tick rate.' },
  moveSecondsPerTile: { label: 'Step time', kind: 'number', unit: 's/tile', min: 0.5, max: 10, step: 0.5, help: 'How long a robot takes to cross one tile.' },
  dailyCapAud: { label: 'Daily cap', kind: 'number', unit: 'A$', min: 0, max: 50, step: 0.05, help: 'Hard limit on paid model spend per world per day.' },
  energyPerAud: { label: 'Energy rate', kind: 'number', unit: 'battery/A$', min: 0, max: 20, step: 0.1, help: 'How much battery each A$ of thinking costs the robot.' },
  hostedModels: { label: 'Hosted models', kind: 'boolean', help: 'Allow paid cloud models. Off keeps every decision on local models and autopilot.' },
};

/** Mean cost of a sample decision in A$, to derive battery per decision. */
const MEAN_DECISION_AUD = 0.0025;

export class SampleAccount implements AccountApi {
  private auth: AuthState;
  private values: Record<string, number | boolean> = {
    paused: false,
    ticksPerRealSecond: 10,
    timeScale: 1,
    moveSecondsPerTile: 0.4,
    dailyCapAud: 2,
    energyPerAud: 1.6,
    hostedModels: true,
  };
  private spent: () => number;

  constructor(params: URLSearchParams, spentToday: () => number) {
    const as = params.get('as');
    const role = as === 'admin' || as === 'visitor' || as === 'spectator' ? as : 'spectator';
    this.auth = {
      user: as ? { id: 'u_sample', name: 'Sample Owner', email: 'owner@example.com', avatarUrl: null } : null,
      role,
      loginAvailable: params.get('login') !== '0',
    };
    this.spent = spentToday;
  }

  private snapshot(): WorldSettings {
    const rate = Number(this.values['energyPerAud']);
    const perDecision = rate > 0 ? MEAN_DECISION_AUD * rate : null;
    return {
      values: { ...this.values },
      schema: SCHEMA,
      derived: {
        batteryPerDecision: perDecision,
        decisionsPerFullBattery: perDecision ? Math.floor(1 / perDecision) : null,
        spentTodayAud: this.spent(),
        dailyCapAud: Number(this.values['dailyCapAud']),
      },
    };
  }

  async me(): Promise<AuthState> {
    return { ...this.auth };
  }

  login(returnTo: string): void {
    // The sample has no provider: sign straight in as the owner (admin) and come back.
    const u = new URL(returnTo);
    u.searchParams.set('as', 'admin');
    location.href = u.toString();
  }

  async logout(): Promise<void> {
    this.auth = { ...this.auth, user: null, role: 'spectator' };
  }

  async settings(): Promise<WorldSettings> {
    return this.snapshot();
  }

  async updateSettings(patch: Record<string, number | boolean>): Promise<WorldSettings> {
    await new Promise((r) => setTimeout(r, 250)); // a network round trip
    if (!this.auth.user) throw new SettingsError(401, 'Sign in to change world settings.');
    if (this.auth.role !== 'admin') throw new SettingsError(403, 'Only admins can change world settings.');
    for (const [field, value] of Object.entries(patch)) {
      const f = SCHEMA[field];
      if (!f) throw new SettingsError(400, `Unknown setting ${field}.`, field);
      if (f.kind === 'boolean' && typeof value !== 'boolean') throw new SettingsError(400, `${f.label} must be on or off.`, field);
      if (f.kind === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new SettingsError(400, `${f.label} must be a number.`, field);
        if (f.min !== undefined && value < f.min) throw new SettingsError(400, `${f.label} must be at least ${f.min} ${f.unit ?? ''}.`.trim(), field);
        if (f.max !== undefined && value > f.max) throw new SettingsError(400, `${f.label} must be at most ${f.max} ${f.unit ?? ''}.`.trim(), field);
      }
      this.values[field] = value;
    }
    return this.snapshot();
  }
}
