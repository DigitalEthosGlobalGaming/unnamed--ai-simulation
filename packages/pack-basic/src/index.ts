import { gridFromRows, loadPack, type Grid, type Pack, type Terrain } from '@uas/core';
import manifest from '../pack.json' with { type: 'json' };
import solarPad from '../objects/solar-pad.json' with { type: 'json' };
import dockObj from '../objects/dock.json' with { type: 'json' };
import ball from '../objects/ball.json' with { type: 'json' };
import fountain from '../objects/fountain.json' with { type: 'json' };
import piano from '../objects/piano.json' with { type: 'json' };
import airdrop from '../objects/airdrop.json' with { type: 'json' };
import mailbox from '../objects/mailbox.json' with { type: 'json' };
import robot from '../archetypes/robot.json' with { type: 'json' };
import garden from '../maps/garden.json' with { type: 'json' };
import { charge, dock } from '../handlers/energy.ts';
import { chase, drop, pickup, push } from '../handlers/ball.ts';
import { rinse, splash } from '../handlers/fountain.ts';
import { play, press } from '../handlers/piano.ts';
import { inspect } from '../handlers/inspect.ts';
import { airdropNeeds, airdropNoise, mailRead } from '../handlers/airdrop.ts';
import { sight } from '../senses/sight.ts';
import { hearing } from '../senses/hearing.ts';

export function basicPack(): Pack {
  return loadPack({
    manifest,
    objects: [solarPad, dockObj, ball, fountain, piano, airdrop, mailbox],
    archetypes: [robot],
    handlers: { charge, dock, pickup, drop, push, chase, rinse, splash, play, press, inspect, airdropNeeds, airdropNoise, mailRead },
    senses: [sight, hearing],
  });
}

/** The first-slice map: a 24 x 16 garden with a hut, pond edge and paths. */
export function gardenGrid(): Grid {
  return gridFromRows(garden.rows, garden.legend as Record<string, Terrain>);
}
