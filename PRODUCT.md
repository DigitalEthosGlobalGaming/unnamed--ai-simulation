# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript monorepo (pnpm workspaces). The viewer (`apps/viewer`) is a browser app using Pixi.js (WebGL) for the world scene and HTML for panels, talking to the backend over REST and WebSocket through `@uas/client`. It has to be fully usable on phones as well as desktop from the start. Full technical design: [Unnamed AI Simulation — Spec.md](Unnamed%20AI%20Simulation%20—%20Spec.md).

## Users

- **Primary, first prototype: the builder/admin (the project owner).** They run worlds, watch the robot live, read its reasoning in the brain feed, scrub the timeline, poke characters and place or move objects. Their job is to see why a character did what it did and whether learning is working.
- **Later: spectators and visitors.** The end goal is a public world. Spectators watch the robots live and replay its history; visitors join as their own character and interact through noises and actions, queued per character. These audiences are planned, not yet designed for.

## Product Purpose

Unnamed AI Simulation is a self-hosted world where AI characters (starting with little robots) live on their own in a 2D tile world, learn what their actions do from experience, and pay for their own thinking with in-world energy. The viewer makes that inner life visible: what each robot senses, needs, believes and decides, and why.

Success for the first prototype: the owner can watch one robot over in-world days and clearly see it learn (for example, that the solar pad only charges in daylight) and see what each decision cost. Ultimate success: a public showcase world that people want to watch and visit.

## Positioning

The characters aren't chatbots. They can't speak text: they communicate only in chains of up to 4 pitched, synthesised noises (`beep-C chirp-E`) whose meaning they learn themselves. They aren't told what objects do and must learn it, and every thought costs energy, so the viewer shows a mind that is cheap, constrained and visibly learning, not a scripted pet or an LLM roleplay. For robots, energy is literally the battery: thinking drains it and the robot has to learn how to recharge.

## Operating Context

- The owner runs the server themself (Docker Compose, optionally fully local models on a Raspberry Pi-class host) and opens the viewer in a browser, on desktop or phone.
- Core workflows: watch live; select a character to inspect needs, mood, energy, memories and beliefs; read the brain feed (tier, model, confidence, cost per decision); scrub or replay history; fork a world; admin edits (spawn, move, poke).
- Noises are audible: the viewer plays each noise chain with Web Audio, positioned by distance and direction.
- Visitors (later) interact through a per-character queue, not on demand.

## Capabilities and Constraints

- World: top-down tile grid, one map per world, many worlds per server.
- Real-time updates arrive as per-tick deltas over WebSocket with region subscribe; replay sessions use the same protocol.
- Costs and caps are in AUD.
- First character: little robots. Battery is energy; needs are cool, signal and curiosity; noises (beep, chirp, trill, buzz) are synthesised in the browser, so there are no sound files.
- Undecided: the robot's name and exact silhouette; synth tuning; default energy-per-AUD rate; visitor queue defaults.

## Brand Commitments

- Name: "Unnamed AI Simulation" (working name), package scope `@uas`.
- Binding visual direction set by the owner: the scene is a top-down, abstract construction blueprint, with diegetic interface (information lives inside the drawing as callouts, tables, title block and markup) and must stay easy to read visually. Details live in the spec's "Viewer look and feel" section and will be developed in DESIGN.md.
- Licence: MIT for code, CC BY 4.0 for first-party pack media.

## Evidence on Hand

- The spec is the only artifact so far. There is no code, no art, no synth presets, no screenshots and no user data yet. Don't invent testimonials, usage numbers or showcase content.
- Inspiration (not owned assets): Pino, the autonomous kiwi at pinos.world.

## Product Principles

1. **Show the mind, not just the body.** Every behaviour should be traceable on screen to what the character sensed, felt and decided.
2. **Learned, not told.** The interface never reveals object effects or noise meanings the character hasn't learned; it shows beliefs as beliefs.
3. **Readable first.** A robot's state and the reason for its last action must be clear at a glance, on a phone as well as a desktop.
4. **Cost is visible.** Energy and money spent on thinking are always inspectable.
5. **Replayable truth.** What the viewer shows comes from the recorded event stream, so any moment can be revisited.

## Accessibility & Inclusion

- Target WCAG 2.2 AA for text contrast and controls.
- Noises are core content, so every played noise also needs a visual form (its note chain shown on screen) for people who can't hear it or have sound off.
- Respect reduced-motion preferences for animated sound arcs and movement trails.
