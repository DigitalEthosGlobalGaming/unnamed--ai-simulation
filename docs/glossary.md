# Glossary

Terms as they are used in the code and these docs. Code identifiers are in `code style`.

| Term | Meaning |
| --- | --- |
| Action | `{ verb, targetId?, args?, reason }`. A character runs at most 3 queued actions from one decision. See [simulation.md](architecture/simulation.md#action-queue-and-statuses). |
| Adapter | A class that implements `DecisionModel` or `ChatModel` for one backend (fake, Ollama, AI SDK, Jev). See [models.md](architecture/models.md#adapters). |
| Affordance | A verb name as a character sees it on an object, with no description of its effect. |
| Airdrop | A catalogue item a visitor dropped into a world: an `airdrop` object the robot perceives only by its tags (`thing-metal-small`). |
| Appraise | A model job that rates how good an outcome felt (refines a memory's valence). Off by default in the garden. |
| Archetype | A character template in a pack: needs, battery, noises, sight and hearing range, mind tuning, sheet lines. |
| Autopilot | The free tier: picks a candidate by utility computed from beliefs, with some curiosity and exploration. |
| AUD | Australian dollars. All costs, caps and the energy exchange rate are in AUD, converted from USD prices with a fixed `audPerUsd`. |
| Battery | The robot archetype's label for energy. |
| Belief | A learned rule about a verb on an object type, by day or by night, e.g. `charge:solarPad@night`. Has expected need changes, valence, support and firmness. |
| Boredom | A value per `verb:objectType` that rises with each use, decays over time, scales down need gains and, past a threshold, lowers mood. |
| Brain feed | The list of decisions (`FeedEntry`): trigger, tier, model, confidence, actions with reasons, usage, energy cost. |
| Cached prefix | The first three prompt parts (rules, sheet, beliefs). Rebuilt only at spawn and on waking, so providers can cache it. |
| Candidate | One option offered to autopilot or a model: a label, the actions it expands to, and its `verb:objectType` key. At most 12. |
| Carry on | The brain does nothing new because the character is busy and the trigger isn't salient enough. |
| Catalogue (airdrop) | The server-wide list of items visitors can drop (`GET /catalog`), edited by admins as JSON. Not the world display catalog below. |
| Catalog | `GET /worlds/:id/catalog`: display data about a world's packs (objects, verbs, archetypes, noises). |
| Chain | The ordered list of models a job tries in the world config's `models.jobs`. |
| Character | An entity with needs, energy and an action queue; NPCs also have a mind. |
| Content pack | A versioned bundle of objects, archetypes, handlers, senses and maps. See [content-packs.md](content-packs.md). |
| Delta | One state change in a tick (`moved`, `needs`, `action`, `vocalize`, `memory`, …). Derived from inputs; see [viewer-integration.md](viewer-integration.md#delta-kinds). |
| Diary | A per-day log of what a character did and felt. Stored as a read model and used as input to reflection. |
| Dock | The robot's home: its `rest` verb is where it usually sleeps, and it cools. It charges nothing (since iteration 2). |
| Drop (queue) | A job the model queue gave up on (`queued too long`, `superseded`, `no model answered`), returned to the mind as a `model.answer` with `answer.dropped`. |
| Effect handler | A TypeScript function that resolves a verb against the world and returns an `EffectResult`. |
| Energy | The built-in need that pays for thinking: every model answer costs `costAud × energyPerAud`. |
| Energy floor | Below it, paid models are skipped. After hitting 0 the mind uses only autopilot until energy is back above it. |
| Entity | Anything in the world: a character or an object. |
| Escalation | A `decide` answer below `escalateBelow` confidence is re-asked through the `plan` chain. |
| Fallback | Feed tier used when a model job timed out or was dropped and autopilot decided instead. |
| Firmness | 0..1 confidence of a belief; autopilot treats ≥ 0.6 as "sure". |
| Fork | A new world started from another world's exact state at a tick, with its own log and config. |
| Hearsay | A belief from a stranger's note (`source: "told"`, firmness 0.15); real experience replaces it. |
| Input event | Anything entering the sim from outside, logged with `seq`, `tick` and `packVersions`. The source of truth. |
| Job | A kind of model work: `decide`, `vocalize`, `appraise`, `scoreMemory`, `plan`, `reflect` (and the unused `route`, `embed`). |
| Lane | A model-queue resource: one per Ollama endpoint, one per cloud model, and an unlimited lane for fakes. |
| LTM / STM | Long-term and short-term memory: small competitive stores; a new memory must out-score the weakest to get in. |
| Mailbox | A basic-pack object with `read`: visitors' notes wait in it, oldest first; its flag (`state.waiting`) shows when one is waiting. |
| Mind | A character's code-driven state and brain (`MindState`, `MindSystem`). |
| `models.load` | Input event telling the minds whether the model queue is backed up. |
| Note | A noise at a pitch, written `noise-pitch`, e.g. `beep-C`. Chains of up to 4 notes are the only way characters communicate. |
| Noise | One of an archetype's base sounds (`beep`, `chirp`, `trill`, `buzz` for robots), synthesised in the browser. |
| Open item | Something pulling at a character (want, unfinished action, question) with a decaying weight. |
| Outcome draft | A memory being formed from a finished action, waiting for optional appraise and score jobs. |
| Pack versions | `name@version#hash` of every loaded pack, stamped on the world and every input; replay refuses a mismatch. |
| Read model | A table derived from deltas for fast queries: `deltas`, `feed`, `diary`. |
| Recorder | Wraps a live world: logs each input before queueing it, and takes snapshots. |
| Reflect | Iteration 1's nightly chat-model job; replaced by the sleep pipeline (consolidate, sheet). |
| Replay session | A re-simulation from a snapshot plus the log, streamed over WebSocket with a `sessionId`. Never calls a model. |
| Salience | 0..1 importance of an observation or trigger; triggers at or above `wakeThreshold` interrupt. |
| Sense | A pure function from world state to observations for one character (`basic.sight`, `basic.hearing`). |
| Sheet | The character sheet: authored lines (some locked) plus self-noticed lines that appear and fade. |
| Snapshot | The full `WorldState` at a tick, compressed in SQLite. |
| Standby | The robot's sleep: drowsy, then asleep at the dock, with consolidation and reflection at night. |
| Tick | One fixed simulation step. In-world seconds per tick and ticks per real second are set per world. |
| Tier | Who made a decision: `autopilot`, `local`, `decision`, `llm` or `fallback` (and `carry-on`, never written to the feed). |
| Trigger | An event that may wake the brain: `sensed`, `heard-noise`, `action-finished`, `action-rejected`, `need-threshold`, `idle-timeout`, `woke-up`, `admin-poke`. |
| Verb | An interaction an object offers (`charge`, `splash`, …) or a built-in (`moveTo`, `vocalize`, `wait`, `rest`, `follow`). |
| Visitor | A signed-in person (or `visitor` API key) who airdrops catalogue items and posts mail. Visitors are not characters. |
| World | One map, its entities, clock and logs, running in its own worker thread. |
| Worth | A memory's competitive score: strength, boosted by recalls, decaying with time since last recall. |
