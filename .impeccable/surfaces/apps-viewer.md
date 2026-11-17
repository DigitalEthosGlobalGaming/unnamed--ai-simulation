---
version: 1
slug: "apps-viewer"
primary_target: "apps/viewer"
related_targets: []
---

# Viewer (apps/viewer)

Mode: Operate (owner/admin tool). Public spectator/visitor surface is a later, separate round.

Audience and job: the owner, desktop or phone, checking a running world: is the robot learning, why did it act, what did it cost. Scope: watch live, inspect, replay. No admin edits. Sample data drives the first build until the API (M7) exists; label it as simulated.

Constraints: Pixi.js scene; every control is a standard HTML control (button, slider, toggle, tabs, table) in blueprint type and colour. Diegetic treatment is limited to what is drawn in the scene. WCAG 2.2 AA, red-pen included. Reduced motion respected. Noise note labels always shown.

Open: robot name and silhouette; whiteprint variant; spectator/visitor entry.

## Direction contract

THESIS: The world is an architect's drawing and the robot's mind is drafted onto it as annotation. Refuses the category default: a dark dashboard with a map widget and a sidebar of cards.

OWN-WORLD: Deep blueprint-blue sheet, fine tile grid with heavier 5-tile lines, near-white line work, cyan-white secondary lines, one red-pen accent for attention only. Upright drafting lettering for labels, a plain sans for panel text. Components: title block, revision table, scale bar, callout leaders, dashed construction circles, revision clouds.

STORY: The owner sees the whole sheet, taps a robot, reads its needs and last decision, follows its brain feed, scrubs back a day and sees the belief that formed.

FIRST VIEWPORT: Desktop: sheet fills about 70% left, title block bottom-right of the sheet with world, in-world clock, day; inspector panel right (needs gauges, current action, beliefs, revision-table brain feed); scale-bar timeline with play/pause along the sheet bottom. Phone: sheet full screen, title block compact top, drawer peeking with needs and current action. Signature interaction: selecting a robot draws its annotations onto the plan; each noise draws a timed sound arc labelled with its notes.

FORM: pinned direction; seed: none (pinned) "top down abstract construction blueprint, but easy to read visually … the 'scene' looks like a construction blueprint, with Diegesis like user interfaces and experience"; "controls stay normal web controls".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
