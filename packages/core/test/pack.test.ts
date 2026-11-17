import { describe, expect, it } from 'vitest';
import { buildRegistry, loadPack, type EffectHandler } from '../src/index.ts';

const noop: EffectHandler = () => ({ ok: true, observation: '' });
const manifest = { name: 'test', version: '1.0.0', licence: 'MIT' };
const lamp = { type: 'lamp', verbs: { toggle: { range: 1, durationTicks: 2, handler: 'test.noop' } } };

describe('pack loading', () => {
  it('validates and fills defaults', () => {
    const pack = loadPack({ manifest, objects: [lamp], archetypes: [], handlers: { noop } });
    expect(pack.objects[0]).toMatchObject({ portable: false, solid: false, tags: [], state: {} });
    const reg = buildRegistry([pack]);
    expect(reg.handlers.has('test.noop')).toBe(true);
    expect(reg.packVersions).toMatch(/^test@1\.0\.0#[0-9a-f]{16}$/);
  });

  it('rejects bad JSON with a readable error', () => {
    expect(() => loadPack({ manifest, objects: [{ type: 'lamp', verbs: { toggle: { range: -1 } } }], archetypes: [], handlers: {} })).toThrow(/objects\[0\]/);
    expect(() => loadPack({ manifest: { ...manifest, version: 'one' }, objects: [], archetypes: [], handlers: {} })).toThrow(/semver/);
  });

  it('rejects verbs pointing at missing handlers', () => {
    const pack = loadPack({ manifest, objects: [lamp], archetypes: [], handlers: {} });
    expect(() => buildRegistry([pack])).toThrow(/unknown handler test\.noop/);
  });

  it('changes version hash when content changes', () => {
    const a = loadPack({ manifest, objects: [lamp], archetypes: [], handlers: { noop } });
    const b = loadPack({ manifest, objects: [{ ...lamp, tags: ['bright'] }], archetypes: [], handlers: { noop } });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
