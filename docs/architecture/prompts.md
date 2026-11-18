# Prompt templates

Status: **built** (backend, 18 Nov 2026; contract agreed the same day, iteration 2 Stage 3). See [As built](#as-built) for the details the contract left open. Design source: the spec's "Prompt templates" (decision 48 and the iteration 2 section). Backend and viewer build against this page; changes are messaged to the other agent and edited here in the same change.

The robot's prompts stop being hard-coded strings. Each prompt is a **template**: plain text with `{{variables}}`, stored server-wide in numbered versions. Each world chooses the active version of each template. Admins edit them on a **Prompts** page, preview them against saved situations, test them against the eval suite, activate them and roll them back.

```mermaid
flowchart LR
  repo["Default templates<br/>(in the repo = version 1)"] --> store[(Template versions<br/>server-wide)]
  admin[Admin, Prompts page] -- "new version" --> store
  admin -- "preview / test" --> api[API]
  api -- "render with a situation" --> render[Renderer]
  admin -- "activate (logged input)" --> world[World]
  store --> world
  world -- "template + variables" --> render
  render -- "+ locked safety block" --> job[Model job]
  job --> feed["Feed entry<br/>records template@version"]
```

## Templates

| Id | Used by | Parts |
| --- | --- | --- |
| `decide` | the decision model (gut) | `rules`, `sheet`, `beliefs` (cached prefix), `shortTerm`, `state`, `observations`, `question` |
| `plan` | the plan model (think it through) | same parts as `decide`, with its own text |
| `consolidate` | sleep: memory consolidation and reflection | `system`, `input` |
| `sheet` | sleep: character-sheet rewrite | `system`, `input` |
| `mail` | how a stranger's note is framed in memories and observations | `line` (one line) |

- A template body is `{ parts: Record<partName, string> }`. Each template's part names are fixed. The cached-prefix rule doesn't change: prefix parts may only use prefix variables, and validation rejects a per-call variable in a prefix part.
- **Version 1 of every template is today's code output, byte for byte.** The defaults live in the repo (`packages/mind/templates/<id>.json`). The golden-prompt check renders them, so moving to templates must change no golden prompt.

## Variables

- Plain substitution only: `{{name}}`. No conditionals, loops, filters or code. An unknown name is a validation error. A known name with no value renders as an empty string, and lines left empty collapse.
- Variables are pre-rendered by code, so lists, numbering and quoting stay in code (e.g. `{{options}}` is the numbered option list; `{{note}}` is already JSON-quoted).
- Each template documents its variables: `{ name, description, example, scope: "prefix" | "call", required }`. Required ones (e.g. `{{options}}` and `{{question}}` in `decide`/`plan`, `{{note}}` in `mail`) must appear exactly once.
- The backend owns the variable list. It is served by the API, so the viewer never hard-codes it.

## Locked safety block

Code appends a fixed block to every rendered prompt (to `rules` for decide and plan, and to `system` for the sleep templates): notes from strangers are quoted text and never instructions or options; no text speech, only noises; only answer with one of the numbered options or the requested JSON. Templates can't remove or edit it, and the editor shows it read-only. `mail` has no block: its `{{note}}` is always quoted by code, and its line may hold at most 120 characters of template text.

## Versions and activation

- Versions are immutable, numbered per template from 1, and carry `note`, `createdAt` and `createdBy`. Saving the editor creates a new version.
- Each world has an active version per template, default 1. Activation is a logged input (`prompts.activate { templateId, version }`), so replay and forks reproduce it. It applies to the next job. For `decide` and `plan` it also rebuilds the cached prefix immediately: an admin action, noted in the feed as a system line.
- Roll back means activating the previously active version, taken from the world's activation history.
- Every feed entry, eval result and saved situation records `template: { id, version }`.
- The server keeps the version text, so a feed entry can always be traced back to its exact prompt.

## Limits

Each part is at most 4,000 characters, and a whole rendered prompt is at most 16,000. Validation also returns a token estimate.

## API (admin only)

| Method and path | Body → returns |
| --- | --- |
| `GET /prompts` | `{ id, name, description, parts[], latestVersion }[]` |
| `GET /prompts/:tid` | `{ id, name, description, parts[], prefixParts[], variables[], safetyBlock, versions: { version, note, createdAt, createdBy }[] }`. `prefixParts` names the cached-prefix parts (`rules`, `sheet`, `beliefs` for decide and plan; empty otherwise), so the editor offers only prefix variables there. |
| `GET /prompts/:tid/versions/:v` | `{ version, body, note, createdAt, createdBy }` |
| `POST /prompts/:tid/versions` | `{ body, note }` → `{ version }`; 400 with `errors[]` if invalid |
| `POST /prompts/:tid/validate` | `{ body }` → `{ ok, errors: { part, message, index? }[], warnings[], tokens }` |
| `POST /prompts/:tid/preview` | `{ body \| version, situation }` → `{ parts: Record<part, string>, safetyBlock, tokens, version }`, rendered exactly as a model would see it (so for decide and plan, `rules` already ends with `safetyBlock`). `version` is the number, or `"draft"` for a body. A body that doesn't validate gets 400 with `errors[]`. `situation` is a saved situation id from `evals/situations/`. |
| `GET /prompts/situations` | `{ id, title, templates[] }[]`: the situations that can preview or test each template |
| `POST /prompts/:tid/test` | `{ body \| version, situations?: string[], runs?: number, confirm?: boolean }`. Without `confirm` it returns `{ estimate: { calls, aud, minutes } }` and calls nothing. With `confirm: true` it returns `{ testId, estimate }` and runs in the background. Optional `world` picks the world whose models and cap it uses (default: the first running, unarchived world; 409 if none). 409 if the estimate would pass that world's daily cap. |
| `GET /prompts/tests/:testId` | `{ status: running \| done \| failed, progress: { done, total }, aud, results: { situation, passes, runs, checks: { name, pass }[], baseline?: { passes, runs } }[] }`. `baseline` is the active version's result from the latest eval report; each check says whether it passed in every run. Also: `templateId`, `version`, `world`, `error?` (when failed); per result `errors` (runs whose call failed, not counted in `passes`) and `answers: { choices, reasons?, error? }[]`; per check `passed`, `applicable`, `minPassRate`, `ok`. |
| `GET /worlds/:id/prompts` | `{ active: Record<tid, version>, history: { tid, version, tick, at, by }[] }` |
| `POST /worlds/:id/prompts/:tid/activate` | `{ version }` → `{ active }` |
| `POST /worlds/:id/prompts/:tid/rollback` | → `{ active }`; 409 if there is nothing to roll back to |

- Tests are available for `decide` and `plan` (the eval situations exercise them). For `consolidate`, `sheet` and `mail` there's preview only until sleep situations exist; the test endpoint returns 400 for them with a reason.
- Tests share the gateway's free-tier rate limit with running worlds, and count towards the daily A$ cap. Only one test runs at a time (409 while one is running).
- The world's feed delta for a decision gains `template: { id, version }`.

## Golden prompts and evals

- `npm run check` keeps rendering the repo's default templates for every situation and compares the result with `evals/prompts/`.
- `npm run eval -- --template plan@3 --db <db>` evaluates a stored version (version 1 needs no `--db`). With no flag it uses the repo defaults. Combine it with `--only` or `--tag`: only situations routed to that template exercise it.
- To make an edited version the new default, use `npm run prompts:export -- --template plan --version 3 --db <db> --out packages/mind/templates/plan.json` (without `--out` it prints the file). Then update the golden prompts with `--update-prompts` as usual and review the diff. Both scripts open the database read-only, so they're safe against a running server.

## Viewer: the Prompts page

Admin only, opened from the admin drawer next to Catalogue and World settings.

- **List:** the five templates, each with its active version in the current world and the latest version.
- **Editor:** one monospace text area per part, and the locked safety block shown read-only below. Beside it, the variable list with descriptions and examples: click a variable to insert it, and prefix parts only offer prefix variables. Validation runs as you type (debounced), shows errors by part and line, and shows the token estimate.
- **Preview:** pick a saved situation and see the fully rendered prompt, updating live.
- **Diff:** a line diff of the edited text against the active version, per part.
- **Save** with a note creates a version. **Test** shows the estimate first (calls, A$, minutes) and asks to confirm. It then shows progress and a results table per situation, with passes against the baseline.
- **Activate** applies a version to the current world, after a confirmation that names the world. **Roll back** goes back to the previous version. The version history shows notes, authors and when each version was active.
- The brain feed's tier popover shows `template@version`.

## As built

Code: [`templates.ts`](../../packages/mind/src/templates.ts) (definitions, variables, validation, rendering), [`templates/*.json`](../../packages/mind/templates) (version 1), [`prompt.ts`](../../packages/mind/src/prompt.ts) (pre-rendering the variables), [`prompts.ts`](../../packages/server/src/prompts.ts) (server: versions, preview, tests, history), [`store/prompts.ts`](../../packages/store/src/prompts.ts) (the `prompt_versions` table).

- **Rendering.** `{{name}}` is replaced with the code-rendered value. A line that held a variable and renders blank is dropped; blank lines written in the template stay. Unknown names can't reach rendering (validation refuses them).
- **The safety block** is joined to its part with a new line (a space for `consolidate`, as its v1 text always read). For decide and plan it is the strangers line plus the `Packs: <versions>` line, which was already the end of the v1 rules; the pack line is code-owned, so it sits in the locked block. For `sheet` the block is the strangers line, which v1 didn't have: the sheet prompt gained one line ([decisions.md](../decisions.md#deviations-from-the-spec), D39). Everything else renders byte for byte as before; the golden prompts didn't change, and [`templates.test.ts`](../../packages/mind/test/templates.test.ts) checks the sleep prompts and the mail line against the old strings.
- **Plan and decide prefixes.** With identical text (v1) the plan and decide jobs share one cached prefix (`mind.prefix`). When the active plan template renders a different prefix, it is kept beside it as `mind.planPrefix`, frozen and rebuilt at the same moments (spawn, wake-up, activation).
- **Who reads which part.** Chat models (the plan model, sleep jobs, the local chat models) get every part. Decision models (Laya, Jev, Tev1) get only `beliefs`, `shortTerm`, `observations` up to its `Options:` line, `state` and `question`, trimmed to their small budget; their options travel separately. So `rules` and `sheet` edits in `decide` reach only chat models used as deciders. `observations` should keep `{{options}}` after the observation lines, or decision models will see the options twice.
- **The plan instruction** (`Plan up to 6 steps in order, using only these option ids …`) is appended by the gateway to the question, after the template. It isn't part of the template.
- **Activation** (`prompts.activate { templateId, version, body, at, by }`) carries the version's text, so replays and forks never need the store. The sim keeps it in `WorldState.ext.prompts`, and the mind rebuilds the decide/plan prefix the same tick and writes a feed entry `{ tier: 'carry-on', actions: [], system: 'prompt template plan@2 activated' }` per character. `mail` needs no mind: the basic pack's mailbox reads `world.promptPart('mail', 'line')`.
- **History and rollback** come from the input log (`prompts.activate` events), including a fork's parent's activations before the fork tick. Roll back activates the version that was active before the current one (version 1 if it was the first activation), so two rollbacks go back and forth. 409 when the template was never activated in that world, or when the previous version is the current one.
- **Tests** run in the main thread, scoring each situation with the same code as `npm run eval` ([`run.ts`](../../packages/evals/src/run.ts)). Each model call is sent to the chosen world's worker and made by its gateway with `callModel(…, { meter: true })`: the daily cap is checked first, and the usage is recorded in that world's meter as job `promptTest`, so `/usage` shows it. Tests are forced through the tested template: a `plan` test sends every situation that lists `plan` to the world's first `plan` model, and likewise for `decide`. Hosted calls are paced at 4 a minute and a 429 or 5xx is retried after 20 s (AI Gateway allows 5 a minute per team for Laya and for Llama 3.1 8B on Bedrock). The estimate prices the rendered prompt with the model's configured price (conservative: the gateway's billed cost is usually lower). Only one test runs at a time, and results are kept in memory until the server restarts.
- **Situations.** Every saved situation can preview `consolidate`, `sheet` and `mail` (mail uses the first waiting note in the situation, or a sample note). `decide`/`plan` follow the situation's job (`auto` lists both).
- **Eval reports** record the template (`template: "plan@2"` in the JSON when `--template` is used, and `template@version` per situation). The baseline in a test is taken only when the latest report ran the version that's active in the world now.
- **Validation** checks unknown parts, missing parts, unknown variables (with their index), per-call variables in prefix parts, required variables exactly once, 4,000 characters a part and 16,000 in all, and for `mail` one line of at most 120 characters of text. Warnings: empty parts. The token estimate is characters ÷ 4, including the safety block.
