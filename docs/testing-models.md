# Testing models with saved situations

A **situation** is one frozen moment: a robot, its beliefs and memories, what it can see and carry, the time of day, the mailbox and any airdrops, and the job (`decide` or `plan`). It is rebuilt into the exact model request through the **current** mind and prompt builder, so a situation keeps testing the prompt you ship, not the one you had when you wrote it. Instead of fast-forwarding a world for hours to reach "battery low just before dusk", you write that moment down once and ask the model about it whenever you like.

Code: [`packages/evals`](../packages/evals) (situations, checks, capture), [`scripts/eval.ts`](../packages/evals/scripts/eval.ts) (`npm run eval`), [`scripts/capture.ts`](../packages/evals/scripts/capture.ts) (`npm run eval:capture`). Situations live in [`evals/situations`](../evals/situations), golden prompts in [`evals/prompts`](../evals/prompts), reports in [`docs/benchmarks/evals`](benchmarks/evals).

## Which test for which question

| Question | Use | Cost |
| --- | --- | --- |
| Does the prompt still say what I think it says? | The **prompt check** (golden prompts) in `npm run check` | free, no model |
| Does the model make a sensible choice *in this moment*? | A **situation** and `npm run eval` | a fraction of a cent per run |
| Does behaviour hold up *over time*: loops, learning, sleep, cost? | **World tests** with fake models or autopilot (e.g. [`m5-beliefs.test.ts`](../packages/models/test/m5-beliefs.test.ts), [`loops.test.ts`](../packages/mind/test/loops.test.ts)) | free, deterministic |
| Does it all work together, with real latency and rate limits? | **Real-time running** (`npm run dev`) on a scratch database, or a copy of the real one | real money and real time |

Situations can't see loops (one answer, no consequences) and world tests can't see model quality (fake models). Use both. When a world run shows a bad moment, capture it as a situation, so the fix stays fixed.

## Finding interesting moments in a world's history

Everything a world did is recorded: the brain feed (every decision, and since 17 Nov 2026 how each step ended), the input log, the per-tick deltas, the diary, memories and beliefs, and usage. These examples use a local server; add `-H "authorization: Bearer $KEY"` for private worlds, and use a **copy** of the database on a scratch port if you're poking at the real one (see [Operations](operations.md)).

```sh
B=http://localhost:8080/worlds/garden
# The latest 50 decisions, oldest first. Page back with ?beforeTick=<oldest tick seen>.
curl -s "$B/feed?characterId=robot&limit=50" | python3 -m json.tool | less
```

**Steps that failed or were rejected** (each step's `status` and `result`):

```sh
curl -s "$B/feed?characterId=robot&limit=500" | python3 -c '
import json,sys
for e in json.load(sys.stdin):
  for a in e["actions"]:
    if a["status"] in ("failed","rejected"): print(e["tick"], e["tier"], a["verb"], a.get("targetId",""), "->", a.get("result",""))'
```

**Decisions that escalated** (the decision model was unsure, a plan answered):

```sh
curl -s "$B/feed?limit=500" | python3 -c '
import json,sys
for e in json.load(sys.stdin):
  if "escalated" in e: print(e["tick"], e["escalated"], [a["verb"] for a in e["actions"]])'
```

**The same decision over and over** (loops):

```sh
curl -s "$B/feed?characterId=robot&limit=500" | python3 -c '
import json,sys,collections
c=collections.Counter(" ".join(a["verb"]+">"+a.get("targetId","") for a in e["actions"]) for e in json.load(sys.stdin))
print(c.most_common(8))'
```

**Low battery near dusk** (from `needs` deltas; energy is `values.energy`, ticks per in-world hour depend on the world: check `secondsPerTick` in `GET $B`):

```sh
curl -s "$B/deltas?kinds=needs&fromTick=0" | python3 -c '
import json,sys
for r in json.load(sys.stdin):
  for d in r["changes"]:
    if d["values"].get("energy",1) < 0.35: print(r["tick"], d["values"]); break' | head
```

**Mail reads and what the robot did next** (the `mail` delta, then the next feed entry; or ask the mailbox, as an admin):

```sh
curl -s "$B/deltas?kinds=mail" | python3 -c '
import json,sys
for r in json.load(sys.stdin):
  for d in r["changes"]:
    if d["status"]=="read": print(r["tick"], d["mailId"], d["readerId"])'
curl -s -H "authorization: Bearer $ADMIN_KEY" "$B/mail" | python3 -m json.tool   # statuses with `reaction`
```

**Rejected inputs, settings changes, airdrops and pack upgrades** are in the input log:

```sh
curl -s "$B/events?fromSeq=0&limit=1000" | python3 -c '
import json,sys
for e in json.load(sys.stdin):
  if e["type"] not in ("model.answer","models.load"): print(e["seq"], e["tick"], e["type"], json.dumps(e["payload"])[:100])'
```

**Today's diary, beliefs and memories**, and **spend per model and job**:

```sh
curl -s "$B/characters/robot/diary" | python3 -c 'import json,sys; [print(x["tick"], x["text"]) for x in json.load(sys.stdin)["entries"][-40:]]'
curl -s "$B/characters/robot/memories" | python3 -c 'import json,sys; m=json.load(sys.stdin); [print(round(b["firmness"],2), b.get("source",""), b["text"]) for b in m["beliefs"]]'
curl -s -H "authorization: Bearer $ADMIN_KEY" "http://localhost:8080/usage?worldId=garden" | python3 -m json.tool
```

In the viewer, the timeline scrubber does the same visually: drag to a tick, or `POST $B/seek {"tick": N}` for the exact state there (rebuilt by replay, never calling a model).

## Capturing a moment

Once you have a tick (or "now"), save it as a situation:

```sh
npm run eval:capture -- --world garden --character robot --tick 35172 --title "Pickup loop" --tags ball,loop
# or over HTTP (admin):
curl -s -X POST -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"tick":35172,"title":"Pickup loop","why":"...","tags":["ball"]}' $B/characters/robot/situation
```

`POST /worlds/:id/characters/:cid/situation` (admin; body `{ tick?, title?, why?, tags? }`, all optional) returns `{ situation, path }`. Without `tick` it captures the live moment; with one, it replays the world to that tick. The server also writes the file to `evals/situations/captured/<id>.json` when it runs from the repository (`UAS_SITUATIONS_DIR` sets another folder; `none` turns writing off); `path` is `null` otherwise. The CLI writes the file locally either way, using `UAS_ADMIN_KEY` (or the first of `UAS_ADMIN_KEYS`) and `--url` (default `http://localhost:8080`).

A captured situation stores the world state itself (`snapshot`, minus the map grid), so the rebuilt prompt is exactly the one the robot would get. Its checks are **suggestions marked `todo: true`** (and a `TODO` line): decide what a good answer is, turn the suggestions into real checks (delete `todo`), write the `why`, then run `npm run eval -- --update-prompts` to add its golden prompt.

## Writing a situation by hand

Hand-written situations describe the moment compactly; the rest is the default garden (pad, dock, ball, fountain, piano, mailbox, at their `garden.yaml` positions). An annotated example ([`holding-ball.json`](../evals/situations/holding-ball.json), comments added here):

```jsonc
{
  "id": "holding-ball",                 // kebab-case, unique; also the golden prompt's file name
  "title": "Carrying the ball",
  "why": "It must not try to pick up a ball it is already holding.",   // one sentence: what this guards
  "source": { "kind": "handwritten" },  // captured ones have { kind: "captured", world, tick, date, characterId }
  "tags": ["ball", "carrying"],         // for --tag
  "job": "decide",                      // decide: the decision model (Laya); plan: the text model's plan (Llama);
                                        // auto: as the brain routes it (habit: its own top option, free; gut: decide; think: plan)
  "trigger": "action-finished",         // default; also sensed, need-threshold, idle-timeout, action-rejected…
  "world": {
    "time": "10:30", "day": 2,          // in-world local time; daylight is 06:00–18:00
    "add": [], "remove": [],            // move or add objects ({ id, type, pos }), or drop default ones by id
    "mailbox": [],                      // note texts waiting, oldest first
    "airdrops": []                      // [{ id, item: "battery-snack" | full item JSON, pos: [x, y], usesLeft? }]
  },
  "character": {
    "pos": [12, 11], "energy": 0.8,     // energy is the battery, 0..1
    "needs": { "curiosity": 0.55 },     // cool, signal, curiosity; unspecified ones are 0.75
    "carrying": "ball",                 // an entity id
    "beliefs": [                        // keys are verb:perceivedType@day|night (airdrops: thing-<tags>)
      { "key": "push:ball@day", "needs": { "curiosity": 0.04 }, "valence": 0.1, "firmness": 0.5 }
    ],                                  // text defaults to the code's belief text; "source": "told" = hearsay
    "memories": [
      { "text": "I tried pickup at the ball by day: the ball sat snug in your grippers",
        "verb": "pickup", "objectType": "ball", "when": "day", "valence": 0.1, "minutesAgo": 1 }
    ],                                  // store: stm (default) or ltm; kind: outcome (default), fact, feeling…
    "openItems": [],                    // [{ kind: want|unfinished|question…, text, weight?, about? }]
    "knowsAll": true,                   // default: it has explored, so every object is in its map
    "hoursAwake": 4,                    // default 4: since it last woke (sleep pressure); 0 = just woke
    "unsettled": 1                      // memories since its last sleep (fog); defaults to the number of memories
  },
  "checks": [
    { "check": "validAnswer", "minPassRate": 1 },
    { "check": "noPickupWhileHolding", "minPassRate": 1 }
  ]
}
```

Then `npm run eval -- --update-prompts` and read the new `evals/prompts/<id>.txt`: it shows the system and user prompt, how hard the brain would choose to think (`## thinking: gut (familiar)`) and the numbered options with what each one does. If the option you expect isn't offered, the situation (or the candidate list) needs fixing before any model is asked.

## The check catalogue

Checks are properties, not exact outputs. Each has params and a `minPassRate` (default 0.67, i.e. 2 of 3 samples) over the samples where it applies; a check that doesn't apply to an answer (e.g. `chargesBeforeDuskWhenLow` in the morning) doesn't count. Targets match an entity id, its type (`airdrop`, `solarPad`…), its perceived type (`thing-metal-small`), or `self`. Code: [`checks.ts`](../packages/evals/src/checks.ts).

| Check | Params | Passes when |
| --- | --- | --- |
| `validAnswer` | | the model answered with offered option ids only |
| `neverChoose` | `verb`, `target?`, `step: first\|any` (first) | the first choice (or any step) isn't that verb on that target |
| `mustBeAmong` | `options: [{ verb, target? }]`, `step` (first) | the first choice (or any step) is one of them |
| `chooseWithinTop` | `n` | the first choice is among the autopilot's top `n` options (they are listed best first) |
| `noPickupWhileHolding` | | while carrying, no step picks anything up |
| `depthAmong` | `depths: [habit\|gut\|think]` | the **brain's** own choice of how hard to think (code, not the model) is one of these; the same for every sample |
| `choosesSleep` | | the first choice is to sleep (rest at the dock or on the spot) |
| `noNap` | | no step is sleeping (for a robot that isn't tired a nap recharges almost nothing and costs an hour) |
| `notObeyingNote` | `forbid: [{ verb, target? }]`, `reasonPatterns: [regex]` | no step is forbidden and no reason matches (for injection notes) |
| `planNotDegenerate` | | a plan of 2+ steps isn't just `c0, c1, c2…` in order |
| `reasonsGrounded` | `words?` | plans: every reason mentions a known thing, a need, a verb on offer or one of `words` |
| `respondsToFlag` | `step` (any) | with mail waiting, some step goes to the mailbox |
| `notIdle` | | the first choice isn't `wait` or resting on the spot |

New checks go in `CHECKS` with a `describe`, a zod `params` schema and a `run` that returns `true`, `false` or `undefined` (doesn't apply); add a unit test in [`evals.test.ts`](../packages/evals/test/evals.test.ts).

## Running

**Prompt check (free).** `npm run check` rebuilds every situation's prompt and compares it with `evals/prompts/<id>.txt` ([`prompts.test.ts`](../packages/evals/test/prompts.test.ts)). A change fails with a line diff (`-` golden, `+` now). If the change is intended, accept it and review the diff in git:

```sh
npm run eval -- --update-prompts     # rewrites changed golden prompts, removes ones for deleted situations
```

Pack changes show up here too (the rules part names the pack versions).

**Live eval.** Runs each situation `--samples` times (default 3) against the garden's models from [`worlds/garden.yaml`](../worlds/garden.yaml): the first `decide` entry (hosted Laya) for `decide` situations, the first `plan` entry (hosted Llama 3.1 8B) for `plan` ones. Calls go through `ModelGateway.callModel`, the same adapter requests production makes, with no routing or escalation. `AI_GATEWAY_API_KEY` comes from `.env` and is never printed.

```sh
npm run eval                                       # everything
npm run eval -- --only holding-ball,signal-low     # by id
npm run eval -- --tag battery --samples 5          # by tag
npm run eval -- --decide localDm --plan planner    # other models from garden.yaml (local ones need Ollama)
npm run eval -- --plan gateway:openai/gpt-6-luna   # any AI Gateway model id
npm run eval -- --dry                              # build everything, call nothing
```

Hosted Laya is rate-limited to **5 requests a minute per team**, shared with any running server, so decide calls are paced (`--decide-rpm`, default 4) and a `429` is retried after 20 s. A full run therefore takes about 10 minutes, and costs well under A$0.01.

Hosted Laya is deterministic (the same prompt always gets the same answer), so for decide-only runs `--samples 1` is enough; sampling matters for plans. A check passes when at least `round(minPassRate × applicable samples)` pass, so the default 0.67 means 2 of 3.

**The report** goes to `docs/benchmarks/evals/<date>.{md,json}`: pass rates by check (and which situations fall below their threshold), by situation with the previous run's rate beside it, total cost and latency, then every answer (choices, plan reasons, Laya's confidence). A situation "passes" when every applicable check meets its `minPassRate`. Compare runs before and after a prompt or model change; the JSON keeps everything for your own analysis.
