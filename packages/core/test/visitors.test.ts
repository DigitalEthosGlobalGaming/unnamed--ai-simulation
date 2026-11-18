import { describe, expect, it } from 'vitest';
import { CATALOG_SEED, CATALOG_TEMPLATES_V1 as CATALOG_TEMPLATES, airdropVerbs, cleanMailText, mailTextProblem, parseDurationSeconds, parseIcon, perceivedType, quoteNote, validateCatalogItem } from '../src/index.ts';

const rules = { needKeys: ['cool', 'curiosity', 'signal'], noiseNames: ['beep', 'chirp', 'trill', 'buzz', 'honk'] };
const base = () => structuredClone(CATALOG_TEMPLATES.find((t) => t.name === 'snack')!.item) as Record<string, unknown>;

describe('icon language', () => {
  it('parses every whitelisted shape with styles', () => {
    const r = parseIcon(
      '<icon><line x1="1" y1="2" x2="3" y2="4" weight="heavy"/><polyline points="0,0 4,4 8,0"/><rect x="2" y="2" w="10" h="10" r="2" shade="dense"/>' +
        '<circle cx="12" cy="12" r="5" dashed="true"/><ellipse cx="12" cy="12" rx="6" ry="3"/><path d="M 2 2 L 10 10 H 20 V 4 A 4 4 0 0 1 12 12 Z" weight="thin"/></icon>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shapes.map((s) => s.kind)).toEqual(['line', 'polyline', 'rect', 'circle', 'ellipse', 'path']);
  });

  it('rejects anything outside the whitelist, with paths', () => {
    const bad = (src: string) => {
      const r = parseIcon(src);
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(bad('<svg><circle cx="1" cy="1" r="1"/></svg>')).toEqual(['']);
    expect(bad('<icon><script/></icon>')).toEqual(['shapes[0]']);
    expect(bad('<icon><circle cx="1" cy="1" r="1" fill="red"/></icon>')).toEqual(['shapes[0].fill']);
    expect(bad('<icon><circle cx="1" cy="1" r="1" onload="x()"/></icon>')).toEqual(['shapes[0].onload']);
    expect(bad('<icon><rect x="30" y="0" w="1" h="1"/></icon>')).toEqual(['shapes[0].x']);
    expect(bad('<icon><path d="M 1 1 C 2 2 3 3 4 4"/></icon>')).toEqual(['shapes[0].d']);
    expect(bad('<icon><text>hi</text></icon>')).toEqual(['shapes[0]']);
    expect(bad('<icon></icon>')).toEqual(['']);
    expect(bad(`<icon>${'<circle cx="1" cy="1" r="1"/>'.repeat(33)}</icon>`)).toEqual(['']);
  });

  it('every template and seed icon is valid', () => {
    for (const t of CATALOG_TEMPLATES) expect(parseIcon(t.item.icon).ok, t.name).toBe(true);
  });
});

describe('catalogue items (schema 1)', () => {
  it('accepts the templates and seed items', () => {
    for (const t of CATALOG_TEMPLATES) expect(validateCatalogItem(t.item, rules), t.name).toMatchObject({ ok: true });
    expect(CATALOG_SEED.map((i) => i.id)).toEqual(['sunflower-seed', 'squeaky-toy', 'cooling-gel', 'heavy-rock']); // schema 2 since Stage 2
  });

  it('reports path-specific errors', () => {
    const errs = (patch: (i: Record<string, unknown>) => void) => {
      const i = base();
      patch(i);
      const r = validateCatalogItem(i, rules);
      return r.ok ? [] : r.errors.map((e) => e.path);
    };
    expect(errs((i) => (i.id = 'Not Kebab'))).toEqual(['id']);
    expect(errs((i) => (i.extra = 1))).toEqual(['']);
    expect(errs((i) => (i.expiresAfter = '3 weeks'))).toEqual(['expiresAfter']);
    expect(errs((i) => ((i.behaviours as Record<string, unknown>[])[0]!.needs = { hunger: 0.2 }))).toEqual(['behaviours[0].needs.hunger']);
    expect(errs((i) => ((i.behaviours as Record<string, unknown>[])[0]!.needs = { energy: 2 }))).toEqual(['behaviours[0].needs.energy']);
    // Decision 46: items can never change the battery.
    const r = validateCatalogItem({ ...base(), behaviours: [{ block: 'affectsNeeds', verb: 'eat', needs: { energy: 0.1 }, observation: 'zap' }] }, rules);
    expect(r.ok ? [] : r.errors).toEqual([{ path: 'behaviours[0].needs.energy', message: 'items can never change the battery' }]);
    expect(errs((i) => ((i.behaviours as unknown[]).push({ block: 'teleport' })))).toEqual(['behaviours[2].block']);
    expect(errs((i) => ((i.behaviours as unknown[]).push({ block: 'consumable', uses: 2 })))).toEqual(['behaviours']);
    expect(errs((i) => ((i.behaviours as unknown[]).push({ block: 'makesNoise', verb: 'eat', notes: ['beep-C'] })))).toEqual(['behaviours[2].verb']);
    expect(errs((i) => ((i.behaviours as unknown[]).push({ block: 'makesNoise', verb: 'ring', notes: ['moo-C'] })))).toEqual(['behaviours[2].notes[0]']);
    expect(errs((i) => (i.icon = '<icon><circle cx="1" cy="1" r="99"/></icon>'))).toEqual(['icon.shapes[0].r']);
  });

  it('builds verbs from blocks; robots perceive drops only by tags', () => {
    const toy = CATALOG_TEMPLATES.find((t) => t.name === 'noise-maker')!.item;
    expect(Object.keys(airdropVerbs(toy)).sort()).toEqual(['chew', 'drop', 'pickup', 'scan', 'squeeze']);
    expect(airdropVerbs(toy).squeeze).toMatchObject({ handler: 'basic.airdropNoise', durationTicks: 4, params: { notes: ['chirp-E', 'chirp-G'] } });
    expect(Object.keys(airdropVerbs(CATALOG_TEMPLATES[2]!.item))).toEqual(['scan']);
    expect(perceivedType({ type: 'airdrop', tags: ['small', 'metal'] })).toBe('thing-metal-small');
    expect(perceivedType({ type: 'ball', tags: ['round'] })).toBe('ball');
    expect(parseDurationSeconds('24h')).toBe(86_400);
  });
});

describe('mail text', () => {
  it('caps length, filters bad words and collapses line breaks', () => {
    expect(mailTextProblem('   ')).toBe('the message is empty');
    expect(mailTextProblem('x'.repeat(281))).toMatch(/280/);
    expect(mailTextProblem('you are a b1tch')).toMatch(/friendly/);
    expect(mailTextProblem('a classic dickens novel')).toBeUndefined();
    expect(cleanMailText('one\n\ntwo three\tfour')).toBe('one two three four');
    expect(quoteNote('say "hi"\nnow')).toBe('"say \\"hi\\" now"');
  });
});
