# Prompt templates

Status: **contract** (agreed 18 Nov 2026, iteration 2 Stage 3). Design source: the spec's "Prompt templates" (decision 48 and the iteration 2 section). Backend and viewer build against this page; changes are messaged to the other agent and edited here in the same change.

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
| `GET /prompts/:tid` | `{ id, name, description, parts[], variables[], safetyBlock, versions: { version, note, createdAt, createdBy }[] }` |
| `GET /prompts/:tid/versions/:v` | `{ version, body, note, createdAt, createdBy }` |
| `POST /prompts/:tid/versions` | `{ body, note }` → `{ version }`; 400 with `errors[]` if invalid |
| `POST /prompts/:tid/validate` | `{ body }` → `{ ok, errors: { part, message, index? }[], warnings[], tokens }` |
| `POST /prompts/:tid/preview` | `{ body \| version, situation }` → `{ parts: Record<part, string>, safetyBlock, tokens }`, rendered exactly as a model would see it. `situation` is a saved situation id from `evals/situations/`. |
| `GET /prompts/situations` | `{ id, title, templates[] }[]`: the situations that can preview or test each template |
| `POST /prompts/:tid/test` | `{ body \| version, situations?: string[], runs?: number, confirm?: boolean }`. Without `confirm` it returns `{ estimate: { calls, aud, minutes } }` and calls nothing. With `confirm: true` it returns `{ testId }` and runs in the background. |
| `GET /prompts/tests/:testId` | `{ status: running \| done \| failed, progress: { done, total }, aud, results: { situation, passes, runs, checks[], baseline?: { passes, runs } }[] }`. `baseline` is the active version's result from the latest eval report. |
| `GET /worlds/:id/prompts` | `{ active: Record<tid, version>, history: { tid, version, tick, at, by }[] }` |
| `POST /worlds/:id/prompts/:tid/activate` | `{ version }` → `{ active }` |
| `POST /worlds/:id/prompts/:tid/rollback` | → `{ active }`; 409 if there is nothing to roll back to |

- Tests are available for `decide` and `plan` (the eval situations exercise them). For `consolidate`, `sheet` and `mail` there's preview only until sleep situations exist; the test endpoint returns 400 for them with a reason.
- Tests share the gateway's free-tier rate limit with running worlds, and count towards the daily A$ cap. Only one test runs at a time (409 while one is running).
- The world's feed delta for a decision gains `template: { id, version }`.

## Golden prompts and evals

- `npm run check` keeps rendering the repo's default templates for every situation and compares the result with `evals/prompts/`.
- `npm run eval -- --template plan@3 --db <db>` evaluates a stored version. With no flag it uses the repo defaults.
- To make an edited version the new default, use `npm run prompts:export -- --template plan --version 3 --db <db>`. It writes the repo file, and the golden prompts are then updated with `--update-prompts` as usual.

## Viewer: the Prompts page

Admin only, opened from the admin drawer next to Catalogue and World settings.

- **List:** the five templates, each with its active version in the current world and the latest version.
- **Editor:** one monospace text area per part, and the locked safety block shown read-only below. Beside it, the variable list with descriptions and examples: click a variable to insert it, and prefix parts only offer prefix variables. Validation runs as you type (debounced), shows errors by part and line, and shows the token estimate.
- **Preview:** pick a saved situation and see the fully rendered prompt, updating live.
- **Diff:** a line diff of the edited text against the active version, per part.
- **Save** with a note creates a version. **Test** shows the estimate first (calls, A$, minutes) and asks to confirm. It then shows progress and a results table per situation, with passes against the baseline.
- **Activate** applies a version to the current world, after a confirmation that names the world. **Roll back** goes back to the previous version. The version history shows notes, authors and when each version was active.
- The brain feed's tier popover shows `template@version`.
