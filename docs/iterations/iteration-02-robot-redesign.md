# Iteration 2: thinking budget, sleep and living objects

Status: **Built, awaiting the owner's try-out** (18 Nov 2026): all four stages built and checked; the owner tries them in the real app before this is marked Done. Contracts: [schema 2](../architecture/objects.md), [prompt templates](../architecture/prompts.md). Design: the spec's [Thinking budget, sleep and living objects](../../Unnamed%20AI%20Simulation%20—%20Spec.md#thinking-budget-sleep-and-living-objects-iteration-2) section and decisions 42–53.

**Goal:** make the robot worth watching. Its battery becomes its thinking budget, sleep becomes how it recharges and grows, objects come alive with state and products, and its thoughts show on the map.

**Success:** over a few in-world days, a viewer can see the robot learn what things do to its body (cool, signal, curiosity) and learn when thinking is worth paying for, and can follow its garden, habits and goal.

**Out of scope:** weather, an experiment board, a songbook, a second robot.

```mermaid
flowchart LR
  S1["Stage 1<br/>Battery, tiers, sleep"] --> S2["Stage 2<br/>Object schema 2 and the new garden"]
  S2 --> S3["Stage 3<br/>Prompt templates and Prompts page"]
  S3 --> S4["Stage 4<br/>Viewer: thoughts, sheet, polish"]
```

Stages land in order, and the owner tries each one in the real app before the next starts. Viewer work for a stage can run alongside its backend work against the contract.

## Stage 1: battery, thinking tiers and sleep

Owner: backend (viewer: battery and sleep display).

- [x] Energy drains only from token-costing calls (decide, plan, reflect, consolidation, sheet rewrite, appraisal, scoring); remove every physical drain (idle drain, `chase`, `splash`, need-delta `energy` from actions).
- [x] `energyPerAud` default 5 (a full battery = A$0.20); the A$0.50 daily cap stays.
- [x] Tier ladder by battery band (plan model → decision model → habit/autopilot → autopilot only), with configurable bands in World settings.
- [x] Thinking-depth choice: habit (free) / gut (decision model) / think it through (plan model). Start rule: unfamiliar or important → think it through; familiar → gut or habit. Record the choice in the feed entry.
- [x] Sleep pressure from time awake and STM fullness; STM fullness is a perceivable "fog" sense.
- [x] Recharge only during sleep, scaled by pressure; minimum sleep 1 in-world hour; wake when rested or full; strong events can wake it after the minimum.
- [x] Sleep pipeline, paid from the battery: consolidation → habit detection → character-sheet rewrite (locked core, one step per sleep, one self-chosen goal, history kept) → `refine` hook (empty, typed extension point that takes the day's feed, outcomes and eval results and returns no proposals).
- [x] Locked sheet core includes "sleeping recharges me and settles my memories".
- [x] Items can't change `energy` (catalogue validation rejects it); admin battery top-up in World settings as a logged input.
- [x] Tests: no physical drain; tier stepping; nap gives ~nothing; minimum sleep; wake rules; sleep pipeline order and cost; refine hook called with the right inputs; replay determinism across a full sleep.
- [x] Eval situations updated: remove solar-pad checks; add "battery low, should choose habit or gut", "foggy, should sleep", "just woke, shouldn't nap".

**Done when:** in a scratch world the robot spends its battery thinking, gets foggy, chooses to sleep, recharges, and its sheet and habits change overnight; the daily cap is never exceeded.

## Stage 2: object schema 2 and the new garden

Owner: backend (viewer: object state on the card, products, planting).

- [x] Schema 2 for world objects and catalogue items: state values; rules over time, from actions and under conditions; products (slot, harvest verb, optional reset); items that are consumed to create objects; appearance descriptions per state band.
- [x] Existing handlers become blocks; pack objects (dock, ball, fountain, piano, mailbox) rewritten in schema 2; schema-1 catalogue items migrated automatically.
- [x] New objects: garden bed, seed, plant (water, growth, stages, flowers that lift curiosity, seed products), watering can (fill at the fountain), antenna mast (signal strong nearby).
- [x] Remove the solar pad and every `charge` verb.
- [x] The robot perceives appearance descriptions, never numbers; the API gives viewers the real values.
- [x] Fresh world: archive the iteration-1 world read-only (database copy plus a read-only server mode or world flag), start a new garden at day 0.
- [x] Catalogue editor accepts schema 2 (templates updated: seed, toy, noise-maker, cooling gel).
- [x] Tests: rule evaluation, products and harvest, planting, appearance bands, schema-1 migration, replay determinism with growing plants.
- [x] Viewer: object card (what the robot sees, real state values against `stateSpec`, products, verbs, who planted it); bed footprint, plants by growth band, the can's water level and the mast's signal range on the map; definition icons for other objects; live planting; archived worlds read only; catalogue editor with schema-2 templates and path-located errors; the offline sample is the new garden. Against the contract and the sample source; check on the real server once the backend lands.

**Done when:** in the new garden the robot can fill the can, water the bed, watch a plant grow over real days, pick a flower or seeds and plant them, and viewers can see every step.

## Stage 3: prompt templates and the Prompts page

Owner: backend (templates, API) and viewer (Prompts page).

- [x] Five templates (decision state, plan, sleep consolidation/reflection, sheet rewrite, mail framing) with documented `{{variables}}` and a code-appended locked safety block.
- [x] Server-wide versioned storage; per-world active version; feed entries record the template version.
- [x] API: list, get, draft, validate (unknown variables), preview against a saved situation, test against the eval situations (cost shown first), activate, roll back.
- [x] Prompts admin page: template list, editor with variable list, live preview, diff against active, Test, Activate, Roll back. (Viewer, against the contract and the sample source; check on the real server once the API lands. The brain feed's detail box shows `template@version`.)
- [x] Golden prompts follow the active version; the free prompt check still runs in `npm run check`.

**Done when:** an admin can edit the plan prompt, preview it, test it against the situations, activate it, see new feed entries use it, and roll it back.

## Stage 4: viewer: thoughts, sheet and polish

Owner: viewer.

- [x] Thought callouts on the map: current reason as a short blueprint note, noise notes as it vocalises, "consolidating…" with a memory count while asleep; respects reduced motion; readable on phones.
- [x] Inspector: character sheet (locked lines marked), edit history by night, goal, habits.
- [x] Battery shown as a thinking budget (A$ equivalent on hover), sleep pressure and fog shown with the needs.
- [x] Brain feed shows the thinking-depth choice and template version.
- [x] Object cards show state values, products ready to harvest and growth over time.
- [x] Impeccable finish review and screenshots, desktop and phone.

- [x] Backend support: the data was already there (`action.reason`, `vocalize` and `sleepWork` deltas for callouts; sheet lines with `locked`, `sheetHistory`, goal and habits from `/memories` and the `sheet`/`habits` deltas; `depth` and `template` on feed entries). New: `GET /worlds/:id/objects/:oid/history` for an object's growth line ([server-and-api.md](../architecture/server-and-api.md#rest-endpoints)).

**Done when:** a new viewer can tell within a minute what the robot is thinking, how much thinking it has left, and what it has learned.

## Risks

- **Cost:** sleep work adds model calls; check the daily spend after Stage 1 with `/usage`.
- **Determinism:** plant growth and sleep timing must stay inside the sim (no clocks); replay tests guard it.
- **Rate limits:** the free gateway tier allows 5 Laya requests a minute shared between the server and evals.
- **Scope:** schema 2 is the largest change; if it slips, ship the garden bed and watering can first and leave item-creates-object for later.

## Changes to the plan

- **Stage 1, fog.** "STM fullness" is measured as memories formed since the last sleep against 4 × the STM size, not the STM's length: the STM keeps only its strongest few and is nearly always full, so its length fogged the head within an hour. ([D35](../decisions.md#deviations-from-the-spec) has the other provisional sleep numbers.)
- **Stage 1, waking when full.** "Full" means a full battery *and* low sleep pressure (< 0.3). A robot that barely thinks never drains its battery, and would otherwise wake after every minimum hour without ever sleeping its pressure off.
- **Stage 1, the solar pad and dock** stay as objects but charge nothing; `chase` and `splash` no longer cost battery; the sim also ignores `energy` need deltas from any handler. The "Battery snack" seed item became a "Fizzy cell" (curiosity and signal) under the same id.
- **Stage 1, sleep jobs.** Two new jobs with their own chains, `consolidate` and `sheet`, replace the nightly `reflect`; their prompts are in the prompt builder ready to become Stage 3 templates. The `refine` hook runs host side in the world runtime (it reads the latest eval report from disk).
- **Stage 1, top-up** is a one-shot `batteryTopUp` World setting (logged as `admin.edit` per robot), so the generic settings UI renders it.
- **Stage 1, choosing to sleep.** The first Stage 1 eval had Laya never choosing sleep (0/9): the decision model doesn't see the character sheet, so "sleep here" meant nothing to it. Sleep options now say what sleep does ("go to sleep here (recharges me, settles my memories)"), the state has a `sleepiness` word next to `head` (fog), a tired robot is less keen on everything else, and pressure ≥ 0.8 makes sleep an obvious choice as a safety net (the eval's `dusk-full-stm` sits at 0.81, where Laya still picked play over sleep). Naps don't pay for sleep work (no consolidation with an empty STM; one sheet step per in-world day).
- **Stage 2.** Built as [objects.md](../architecture/objects.md) says, with the details in its [As built](../architecture/objects.md#as-built) section (rule `remove`, product timers on the entity, `objectView`/`catchUp` deltas, a `seed` tag for planting, the tuning). The archive step and the fresh world are scripts plus a world-file flag; the owner runs them on the live database. `worlds/garden2.yaml` ships as the default world, so a restart also creates `garden2` at day 0.
- **Stage 3.** Built as [prompts.md](../architecture/prompts.md) says, with the details in its [As built](../architecture/prompts.md#as-built) section; the sheet sleep prompt gained the safety line ([D39](../decisions.md#deviations-from-the-spec)). First use (18 Nov, scratch server, Llama 3.1 8B, 2 runs per situation, A$0.0021 in all): a `plan` v2 asking for short plans that use what it holds and keep set-up steps together passed 12/16 runs against v1's 11/16 and made shorter plans, but the target chain didn't move: at the fountain with an empty can both versions drop the can first (0/2). The option reads "fill the fountain", which sounds like filling the fountain, so the next try is the option label rather than the template. The repo default stays v1.
- **Stage 3 follow-up, option wording.** An option whose verb needs something held now names it, read from the schema-2 verb (`requires.holding` and which `changeState` targets it has): "fill the watering-can at the fountain" (only the held item changes) and "water the plant with the watering-can" (both change). Live, 3 runs each (A$0.0004): `empty-can-at-fountain` still 0/3 on the first step, but `fill` moved from 3rd–5th place to 2nd in every plan, with reasons like "I want to fill the watering-can"; the model still puts `drop` first, which is the top option because untried options tie and the held item's options come first (nearest). `dry-plant-full-can` and `flower-ready` stay 3/3. Then the tie-break: `drop` ranks as if 5 tiles further and options that use the held thing as if 5 tiles nearer (ranking only; [mind.md](../architecture/mind.md#candidates)), so "fill the watering-can at the fountain" is now the first option and "drop" comes after the fountain's verbs. Live, 3 runs each (A$0.0012, [report](../benchmarks/evals/2026-11-18-3.md)): `empty-can-at-fountain` 0/3 → **3/3** (fill first every time), `dry-plant-full-can`, `flower-ready`, `holding-ball` and `pickup-loop-2026-11-17` stay 3/3. The plan model mostly keeps the listed order, so the order did more than the wording.
