import { describe, expect, it } from 'vitest';
import {
  CATALOG_SEED,
  CATALOG_TEMPLATES,
  CATALOG_TEMPLATES_V1,
  appearanceOf,
  checkCondition,
  compileObjectDef,
  migrateToSchema2,
  validateCatalogItem2,
  validateObjectDef2,
  type ObjectDef2,
} from '../src/index.ts';

const rules = { needKeys: ['cool', 'curiosity', 'signal'], noiseNames: ['beep', 'chirp', 'trill', 'buzz'], packTypes: ['plant', 'seed'], knownTypes: ['plant', 'seed', 'flower'] };
const gel = () => structuredClone(CATALOG_TEMPLATES.find((t) => t.name === 'cooling gel')!.item) as ObjectDef2;

describe('object schema 2', () => {
  it('the templates and the seed are valid catalogue items', () => {
    expect(CATALOG_TEMPLATES.map((t) => t.name)).toEqual(['seed', 'toy', 'noise-maker', 'cooling gel']);
    for (const t of CATALOG_TEMPLATES) expect(validateCatalogItem2(t.item, rules), t.name).toMatchObject({ ok: true });
    for (const i of CATALOG_SEED) expect(validateCatalogItem2(i, rules), i.id).toMatchObject({ ok: true });
  });

  it('reports path errors, and the catalogue refuses handlers, energy and pack ids', () => {
    const errs = (patch: (d: Record<string, unknown>) => void) => {
      const d = gel() as unknown as Record<string, unknown>;
      patch(d);
      const r = validateCatalogItem2(d, rules);
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    const verbs = (d: Record<string, unknown>) => d.verbs as Record<string, { effects: unknown[] }>;
    expect(errs((d) => verbs(d).dab!.effects.push({ block: 'changeState', values: { colour: 1 } }))).toEqual(['verbs.dab.effects[2].values.colour']);
    expect(errs((d) => verbs(d).dab!.effects.push({ block: 'handler', name: 'basic.push' }))).toEqual(['verbs.dab.effects[2].block']);
    expect(errs((d) => verbs(d).dab!.effects.push({ block: 'affectNeeds', needs: { energy: 0.1 }, observation: 'zap' }))).toEqual(['verbs.dab.effects[2].needs.energy']);
    expect(errs((d) => verbs(d).dab!.effects.push({ block: 'affectNeeds', needs: { hunger: 0.1 }, observation: 'x' }))).toEqual(['verbs.dab.effects[2].needs.hunger']);
    expect(errs((d) => (d.id = 'plant'))).toEqual(['id']);
    expect(errs((d) => (d.appearance = { uses: [{ text: 'fallback' }, { lt: 1, text: 'empty' }] }))).toEqual(['appearance.uses[0]']);
    expect(errs((d) => ((d.verbs as Record<string, unknown>).scan = { effects: [{ block: 'observe', text: 'x' }] }))).toEqual(['verbs.scan']);
    expect(errs((d) => (d.rules = [{ every: '2h', change: { uses: -1 } }]))).toEqual(['rules[0].every']);
    // Pack objects may use handler blocks.
    expect(validateObjectDef2({ schema: 2, id: 'x', name: 'X', verbs: { go: { effects: [{ block: 'handler', name: 'basic.push' }] } } }, { pack: true }).ok).toBe(true);
  });

  it('conditions and appearance bands (first match wins; the unbounded band is the fallback)', () => {
    expect(checkCondition({ water: { gte: 0.3, lt: 0.9 } }, { water: 0.5 })).toBe(true);
    expect(checkCondition({ water: { gte: 0.3, lt: 0.9 } }, { water: 0.9 })).toBe(false);
    expect(checkCondition({ water: { eq: 0 } }, {})).toBe(true); // missing counts as 0
    const def = { appearance: { water: [{ lt: 0.15, text: 'cracked' }, { lt: 0.5, text: 'dry' }, { text: 'damp' }], growth: [{ lt: 0.4, text: 'shoot' }, { text: 'leafy' }] } };
    expect(appearanceOf(def, { water: 0.1, growth: 0.5 })).toEqual(['cracked', 'leafy']);
    expect(appearanceOf(def, { water: 0.49, growth: 0 })).toEqual(['dry', 'shoot']);
    expect(appearanceOf(def, { water: 0.5, growth: 0 })).toEqual(['damp', 'shoot']);
  });

  it('compiles: verbs run blocks, portable adds pickup and drop, products add their verb', () => {
    const plant = validateObjectDef2(
      {
        schema: 2, id: 'plant', name: 'Plant', state: { growth: { initial: 0 } },
        verbs: { water: { effects: [{ block: 'changeState', values: { growth: 0.1 } }] } },
        products: [{ slot: 'flower', item: 'flower', when: { growth: { gte: 0.7 } }, everyHours: 24, max: 1, verb: 'pick', reset: { growth: 0.6 } }],
      },
      { pack: true },
    );
    expect(plant.ok).toBe(true);
    const c = compileObjectDef((plant as { def: ObjectDef2 }).def);
    expect(Object.keys(c.verbs)).toEqual(['water', 'pick']);
    expect(c.verbs.pick).toMatchObject({ handler: 'core.blocks', params: { effects: [{ block: 'harvest', slot: 'flower' }], reset: { growth: 0.6 } } });
    expect(c.state).toEqual({ growth: 0 });
    expect(Object.keys(compileObjectDef(gel()).verbs)).toEqual(['dab', 'pickup', 'drop']);
  });
});

describe('schema-1 migration', () => {
  it('is lossless and idempotent: needs, noise, consumable uses, portable and inert', () => {
    const [snack, toy, rock] = CATALOG_TEMPLATES_V1.map((t) => t.item as unknown as Record<string, unknown>);
    const s = migrateToSchema2(snack!) as unknown as ObjectDef2;
    expect(s).toMatchObject({ schema: 2, id: 'battery-snack', portable: true, expiresAfter: '24h', state: { uses: { initial: 1, min: 0, max: 1 } } });
    expect(s.verbs.eat!.effects).toEqual([{ block: 'affectNeeds', needs: { curiosity: 0.05, signal: 0.05 }, observation: 'a fizzy tingle' }, { block: 'consume', target: 'self', uses: 1 }]);
    const t = migrateToSchema2(toy!) as unknown as ObjectDef2;
    expect(t.verbs.squeeze!.effects[0]).toEqual({ block: 'makeNoise', notes: ['chirp-E', 'chirp-G'], observation: 'it squeaked' });
    expect(Object.keys((migrateToSchema2(rock!) as unknown as ObjectDef2).verbs)).toEqual([]);
    for (const x of [snack!, toy!, rock!]) {
      const once = migrateToSchema2(x);
      expect(migrateToSchema2(once)).toBe(once);
      expect(validateCatalogItem2(once, rules)).toMatchObject({ ok: true });
    }
    // Energy in an old item is dropped on migration (decision 46).
    const old = { ...snack!, behaviours: [{ block: 'affectsNeeds', verb: 'eat', needs: { energy: 0.1, curiosity: 0.02 }, observation: 'zap' }] };
    expect((migrateToSchema2(old) as unknown as ObjectDef2).verbs.eat!.effects[0]).toMatchObject({ needs: { curiosity: 0.02 } });
  });
});
