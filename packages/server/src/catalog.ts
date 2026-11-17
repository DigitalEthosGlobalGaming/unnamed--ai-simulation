import { buildRegistry, type Grid, type Pack, type Registry } from '@uas/core';
import { basicPack, gardenGrid } from '@uas/pack-basic';

/** Packs this server can load, by name. Third-party packs would register here (npm-installed). */
const PACKS: Record<string, { pack: () => Pack; maps: Record<string, () => Grid> }> = {
  basic: { pack: basicPack, maps: { garden: gardenGrid } },
};

export function loadPacks(names: string[]): { packs: Pack[]; registry: Registry } {
  const packs = names.map((n) => {
    const entry = PACKS[n];
    if (!entry) throw new Error(`unknown content pack ${n}`);
    return entry.pack();
  });
  return { packs, registry: buildRegistry(packs) };
}

export function loadMap(ref: string): Grid {
  const [pack, map] = ref.split(':');
  const fn = PACKS[pack ?? '']?.maps[map ?? ''];
  if (!fn) throw new Error(`unknown map ${ref}`);
  return fn();
}

export function listPacks() {
  return Object.values(PACKS).map((p) => {
    const pack = p.pack();
    return { name: pack.manifest.name, version: pack.manifest.version, licence: pack.manifest.licence, contentHash: pack.contentHash, maps: Object.keys(p.maps) };
  });
}
