# Viewer integration

How a frontend (e.g. `apps/viewer`) talks to `@uas/server`. Every type named here is exported
from `@uas/client` (which re-exports `@uas/core`), so a viewer can import the shapes and the
client from one place:

```ts
import { UasClient, type Delta, type FeedEntry, type ServerMessage } from '@uas/client';

const api = new UasClient('http://localhost:8080', apiKey /* optional */);
const stream = api.connect();          // WebSocket at ws://host/ws?key=...
await stream.open;
stream.on('snapshot', (m) => render(m.state));
stream.on('deltas', (m) => apply(m.tick, m.changes));
stream.on('feed', (m) => addFeedRow(m.entry));
stream.on('noises', (m) => play(m.noises));
stream.subscribe('garden', { channels: ['deltas', 'feed', 'noises'], region: { x: 0, y: 0, w: 24, h: 16 } });
```

## Auth

- REST: `Authorization: Bearer <key>` (or `x-api-key`). WebSocket: `/ws?key=<key>`.
- Roles: `admin`, `visitor`, `spectator`. Keys come from `UAS_ADMIN_KEYS`, `UAS_VISITOR_KEYS` and
  `UAS_SPECTATOR_KEYS` (comma-separated). With `publicRead: true` in the world config,
  spectators need no key. Unknown keys get 401; too low a role gets 403.

## WebSocket protocol

Client to server (`ClientMessage`):

| Message | Meaning |
| --- | --- |
| `{ type: 'subscribe', worldId, channels?, region? }` | Live stream. Channels default to all of `deltas`, `feed`, `noises`. `region` is a tile rect `{ x, y, w, h }`. |
| `{ type: 'unsubscribe', worldId }` | Stop the live stream. |
| `{ type: 'replay.open', worldId, tick }` | Open a replay session at `tick`. |
| `{ type: 'play', sessionId, speed? }` / `pause` / `seek` (with `tick`) / `replay.close` | Control a replay session. A session opened with `POST /worlds/:id/seek` can be driven from any socket. |

Server to client (`ServerMessage`):

| Message | When |
| --- | --- |
| `snapshot { worldId, sessionId?, tick, state }` | Once after `subscribe`, and after `replay.open` / `seek`. `state` is the full `WorldState`. |
| `deltas { worldId, sessionId?, tick, changes: Delta[] }` | Each tick that changed something (feed entries are not repeated here). |
| `feed { worldId, sessionId?, entry: FeedEntry }` | Each brain decision. |
| `feedStep { worldId, sessionId?, characterId, feedTick, step, status, result? }` | A step of an earlier feed entry resolved (`done`, `failed`, `rejected`, `superseded`). |
| `noises { worldId, sessionId?, tick, noises }` | Each `vocalize` (the same `vocalize` deltas, on their own channel for audio). |
| `replay.opened { worldId, sessionId, tick }`, `replay.ended { sessionId, tick }` | Replay lifecycle; a replay ends when it reaches the live tick. |
| `error { message }` | A bad message or an action that isn't allowed. |

Live messages carry no `sessionId`; replay messages always do.

### `WorldState` (the snapshot)

```ts
{
  config: { worldId, seed, grid: { width, height, terrain: Record<string, { walkable, blocksSight, soundDamping }>, tiles: string[] },
            secondsPerTick, dayLengthSeconds, startSecond, moveTicksPerTile },
  packVersions: string,      // 'basic@0.1.0#…'
  tick: number,              // the next tick to run
  entities: Record<EntityId, Character | WorldObject>,
  mailbox?: { queue: { mailId, text, by: { username, admin, userKey }, postedTick, expiresTick? }[] },  // text is '' unless you are an admin
  ext: { mind: MindConfig }, rng, nextId, mapVersion
}
```

- `grid.tiles` is row-major (`tiles[y * width + x]`) and holds terrain keys. In the garden,
  `#` is a wall (blocks sight), `~` is water, `*` is a rock, and `.` and `:` are floor and path.
- In-world time: `seconds = state.clock.baseSeconds + (tick − state.clock.baseTick) × secondsPerTick`. In a real-time world (`WorldStatus.clockMode`), these are local wall-clock seconds since the epoch, so `new Date(seconds * 1000)` read with UTC getters gives the local date and time. A `clock` delta (`{ seconds, previous, reason, timezone }`) marks an anchor or a jump; reset any clock display there. With slow ticks (1 per second, 2 per tile), interpolate movement between `moved` deltas. Read `secondsPerTick` from the
  state rather than assuming it (the garden uses 2). Real-time pacing is
  `ticksPerRealSecond × timeScale` ticks per real second (the real-time garden: 1 tick per second at 1 s per tick; scaled test worlds run faster); both come with `WorldStatus`. The day number is
  `floor(seconds / dayLengthSeconds)`. It is daylight from 06:00 to 18:00.
- An entity has `{ id, kind: 'character' | 'object', type, pos: { x, y }, tags, state, heldBy? }`.
  Characters also have `needs` (`cool`, `signal`, `curiosity`, each 0..1), `energy` (the battery,
  0..1), `queue`, `current` (`{ action, startedTick, endsTick?, path? }`) and `mind` (`MindState`:
  mood, beliefs, memories, open items, sleep phase…). A display name, when configured, is `state.name`
  (the garden robot has `name: 'Robot'`); fall back to the id.
- Visitors are not entities. A dropped item is an object of `type: 'airdrop'` (id `drop-<dropId>`,
  `tags` from the item) whose `state` has `dropId`, `itemId`, `item` (the catalogue JSON copy, with its
  icon), `droppedBy { username, admin }`, `droppedTick`, and `usesLeft` / `expiresTick` when they apply.
  The `mailbox` object's `state.waiting` is the number of messages waiting: draw the flag up when it's above 0.
  Details and REST shapes: [visitors.md](architecture/visitors.md).

### `Delta` kinds

| kind | Fields | Draw it as |
| --- | --- | --- |
| `spawned` | `entity` | add a symbol |
| `despawned` | `id` | remove it |
| `moved` | `id, from, to` | move it (one tile per step, so a dashed trail is easy) |
| `state` | `id, set` | merge into `entity.state` |
| `held` | `id, heldBy \| null` | carried item |
| `needs` | `id, values` (any of the needs and `energy`) | gauges. Sent every 50 ticks and when an effect changes them. |
| `mood` | `id, valence, arousal, word` | mood word, sent when the word changes |
| `action` | `id, action { verb, targetId?, args?, reason }, status, reason?, observation?` | current-action callout. `status` is one of `queued`, `started`, `done`, `failed`, `rejected` or `cancelled`. Draw `rejected` and `failed` as red-line alerts. |
| `vocalize` | `id, pos, notes` | sound arcs and labels, `beep-C · chirp-E` |
| `memory` | `id, memory, evicted?` | memory admitted (store `stm` or `ltm`) |
| `beliefs` | `id, beliefs` | sent after each night's consolidation |
| `sleep` | `id, phase` (`awake`, `drowsy` or `asleep`) | standby indicator |
| `diary` | `id, day, text` | story view |
| `airdrop` | `event` (`added`, `used` or `removed`), `dropId, entityId, itemId, pos?, verb?, by?, reason?` (`expired`, `used up` or `deleted`) | landing, use and removal; the entity itself comes and goes with `spawned` / `despawned` |
| `mailbox` | `waiting` | the mailbox count and flag |
| `mail` | `mailId, status` (`waiting`, `read`, `expired` or `deleted`), `readerId?` | a message's status changed (no text) |
| `inputRejected` | `seq, type, reason` | admin-tool error |
| `clock` | `seconds, previous, reason, timezone` | the world clock was anchored or jumped (`anchor`, `restart`, `resume`, `realign`, `sync`), or its rate changed (`rate`, after a logged `sim.config`) |

### `FeedEntry`

`{ tick, characterId, trigger, tier, modelId?, confidence?, actions: [{ verb, targetId?, reason, status }], usage?, energyCost?, notes?, reason?, escalated? }`

- Each step's `status` starts `queued` and is updated as it resolves: `done` (with `result`, the observation), `failed` (it started but didn't work; `result` is why), `rejected` (invalid when its turn came; `result` is why), or `superseded` (a newer decision replaced it before it ran). Live updates arrive as `feedStep { worldId, sessionId?, characterId, feedTick, step, status, result? }` messages on the feed channel (and `feedStep` deltas in the store): update `actions[step]` of the entry with that `characterId` and `tick === feedTick`. `GET /feed` returns entries already updated.
- `escalated: { from, confidence }` marks a decision the decision model (`from`) was unsure about, answered by a stronger model or a text-model plan. Plans (tier `llm`) carry no `confidence`.

- `tier: 'carry-on'` marks the later steps of a model plan that run without a new call.
- `reason` explains a `fallback`: `queued too long` (the model queue dropped the job as stale), `no model answered`, or `no answer in time`.

- `tier` is one of `autopilot`, `local`, `decision`, `llm` or `fallback`.
- `usage` is `{ inputTokens, cachedInputTokens, outputTokens, costAud, latencyMs, modelId }`.
- `energyCost` is the battery spent on that thought: `costAud × energyPerAud`.

### Noise playback

Read pitches and synth settings from the archetype in the pack (`packages/pack-basic/archetypes/robot.json`):

- Pitches: `{ C: 523.25, D: 587.33, E: 659.25, G: 783.99 }` Hz.
- Each noise has a `synth` setting: `{ wave, ms, sweep?, vibratoHz?, octave?, rough? }`.

A note `chirp-E` means the `chirp` noise played at E. Play the notes of a chain in order.

## REST (selected)

| Method and path | Role | Returns |
| --- | --- | --- |
| `GET /worlds` | spectator | `WorldSummary[]` with live `status` (`WorldStatus`): `tick, day, timeOfDay, paused, timeScale, clockMode, timezone, worldSeconds, driftSeconds, ticksPerRealSecond, idleTicksPerRealSecond, watched, effectiveTicksPerRealSecond, secondsPerTick, inWorldSecondsPerRealSecond, pendingJobs, mailWaiting, costAudToday, modelLatencyMs, tickLagMs, queue` where `queue` is `QueueStats { waiting, running, byLane, waitMs {p50,p95,max}, runMs {p50,p95,max}, completed, dropped {stale, superseded, failed}, timeouts }` |
| `GET /worlds/:id/catalog` | spectator | `WorldCatalog`: pack objects (type, tags, portable, solid, verbs), archetypes (needs, energy, noises, ranges), `ticksPerRealSecond` (`ticksPerSecond` is a deprecated alias), `secondsPerTick`, cost settings, `models` (id = the feed's `modelId`, adapter, model, provider, local) |
| `GET /worlds/:id` | spectator | `WorldSummary` |
| `PATCH /worlds/:id/clock` | admin | `{ paused?, timeScale?, realign? }` sets the clock and returns the status; real-time worlds re-align (logged jump) on resume, on `timeScale` back to 1, or on `realign: true` |
| `POST /worlds/:id/entities` | admin | body `EntityDef { type, pos, id?, state? }`; returns the logged `InputEvent` |
| `PATCH /worlds/:id/entities/:eid` | admin | body `{ pos?, state?, needs?, energy? }` |
| `DELETE /worlds/:id/entities/:eid` | admin | removes the entity |
| `GET /worlds/:id/characters/:cid/mind` | spectator | `MindView` (needs, energy, mood, sleep, open items, queue, pending jobs) |
| `GET /worlds/:id/characters/:cid/memories` | spectator | `{ stm, ltm, beliefs, sheet }` |
| `GET /worlds/:id/characters/:cid/diary?day=` | spectator | `{ day, entries: [{ tick, text }] }` |
| `POST /worlds/:id/characters/:cid/poke` | admin | raises an `admin-poke` trigger |
| `GET /catalog`, `GET /catalog/templates`, `POST /catalog/validate`, `PUT` / `DELETE /catalog/:itemId` | spectator / admin | the airdrop catalogue ([visitors.md](architecture/visitors.md#rest)) |
| `GET /worlds/:id/airdrops`, `GET /worlds/:id/airdrops/:dropId` | spectator | `Airdrop[]`; one `Airdrop` with `beliefs` about it |
| `POST /worlds/:id/airdrops` | visitor | body `{ itemId, pos }`; returns the `Airdrop` (`client.dropItem`) |
| `GET /worlds/:id/mail`, `POST /worlds/:id/mail` | spectator / visitor | `{ waiting, mine?, all? }`; post `{ text }` (`client.postMail`) |
| `DELETE /worlds/:id/airdrops/:dropId`, `DELETE /worlds/:id/mail/:mailId` | admin | remove a drop or a waiting message |
| `GET /worlds/:id/feed?characterId=&limit=` | spectator | `FeedEntry[]`, oldest first |
| `GET /worlds/:id/deltas?fromTick=&toTick=&kinds=` | spectator | `[{ tick, changes }]`, for fast scrubbing without re-simulating; `kinds=beliefs,sleep` filters delta kinds |
| `GET /worlds/:id/events?fromSeq=&limit=` | spectator | the input log (`mail.post` without `text` unless you are an admin) |
| `POST /worlds/:id/seek` | spectator | body `{ tick }`; returns `{ sessionId, tick, state }` |
| `POST /worlds/:id/fork` | admin | body `{ tick, id?, config? }`; starts the fork |
| `GET /usage?worldId=&day=` | admin | `{ [worldId]: { rows: UsageRow[], queue: QueueStats } }`: tokens, AUD and energy by model and job, plus model queue depth and wait/run times |
| `GET /healthz`, `GET /metrics` | anyone | health, and Prometheus text |

## Login and settings

- **Login.** Call `client.me()` (`GET /auth/me`), which returns `{ user | null, role, loginAvailable }`.
  - To sign in, navigate to `client.loginUrl(returnTo)` (`/api/auth/login?returnTo=/path`). Failures come back as `/?authError=...`.
  - Sign out with `client.logout()`.
  - The session is a cookie, so same-origin requests through the Vite `/api` proxy are authenticated automatically. Mutations need the browser's own `Origin`, which browsers send.
- **Settings.**
  - `client.settings(id)` returns `{ values, schema, derived }`. Render each `schema` entry generically (`kind` number, boolean, or `string[]` for `catalogEnabled`, a list of item ids where `*` means all; with `label`, `unit`, `min`, `max`, `step` and `help`), and show `derived` read-only (battery per decision, decisions per full battery, A$ spent versus the cap).
  - `client.updateSettings(id, patch)` (admin) returns `{ values, derived, effects }`.

## Timeline scrubbing

- **Fast:** page `GET /worlds/:id/deltas` and apply the changes on top of a snapshot.
- **Exact:** open a replay with `replay.open`, or `POST /seek` then `play`. The server rebuilds
  the state from the nearest snapshot plus the input log, and never calls a model.
