# Iterations

Each iteration is a planned slice of work: what it changes, the stages it lands in, and how we know each stage is done. Design decisions live in the spec's [decision log](../../Unnamed%20AI%20Simulation%20—%20Spec.md#decision-log-and-open-questions); an iteration page turns them into a build plan and tracks progress.

| Iteration | Theme | Status |
| --- | --- | --- |
| [1](iteration-01-first-slice.md) | First playable slice: one robot, the garden, models, viewer, visitors | Done |
| [2](iteration-02-robot-redesign.md) | Thinking budget, sleep and living objects | In progress (Stage 1 built; Stage 2 backend built) |

## How to use an iteration page

- One owner per stage (backend or viewer agent, or a person). Stages land in order; each is tried in the real app before the next starts.
- Tick a task only when it is merged, `npm run check` passes and the docs that own the change are updated.
- If the plan changes, edit the page in the same change and say why under **Changes to the plan**.
- When the iteration ends, set its status to Done and add a short **Outcome** section: what shipped, what moved to the next iteration, and anything learned.
