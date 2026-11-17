---
name: Unnamed AI Simulation
description: A robot world drawn as a construction blueprint, with each robot's mind marked up on the sheet.
colors:
  sheet: "#0e2f5a"
  sheet-deep: "#0a2549"
  sheet-raise: "#143d70"
  sheet-press: "#1a4880"
  ink: "#eaf2ff"
  ink-2: "#a9d4f5"
  ink-3: "#86b4de"
  rule: "rgb(169 212 245 / 0.22)"
  rule-strong: "rgb(169 212 245 / 0.5)"
  red-pen: "#ff8a7e"
  red-wash: "rgb(255 138 126 / 0.1)"
  focus: "#fff3c4"
typography:
  display:
    fontFamily: "Overpass, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "Overpass, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 700
    letterSpacing: "0.04em"
  title:
    fontFamily: "Overpass, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    letterSpacing: "0.05em"
  action:
    fontFamily: "Overpass, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    letterSpacing: "0.02em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "Overpass, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    letterSpacing: "0.03em"
  value:
    fontFamily: "Overpass, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    letterSpacing: "0.03em"
    fontFeature: "tnum"
  label:
    fontFamily: "Overpass, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.04em"
  scene-label:
    fontFamily: "Overpass, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.6px"
rounded:
  hairline: "2px"
  tag: "3px"
  control: "4px"
  drawer: "12px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
components:
  button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  button-hover:
    backgroundColor: "{colors.sheet-raise}"
  button-active:
    backgroundColor: "{colors.sheet-press}"
  button-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
  button-icon:
    backgroundColor: "{colors.sheet-deep}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    size: "40px"
  status-chip:
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.tag}"
    padding: "4px 10px"
  status-chip-disconnected:
    textColor: "{colors.red-pen}"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-3}"
    padding: "0 12px"
    height: "40px"
  tab-selected:
    textColor: "{colors.ink}"
  select:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 6px"
    height: "30px"
  alert:
    backgroundColor: "{colors.red-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  schedule-header:
    backgroundColor: "{colors.sheet-deep}"
    textColor: "{colors.ink-2}"
    padding: "6px 4px"
  drawer:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.drawer}"
    height: "88dvh"
---

# Design System: Unnamed AI Simulation

## Overview

**Creative North Star: "The Annotated Ground Plan"**

The viewer is one sheet of a drawing set. The world is a top-down ground plan on deep blueprint paper: a fine tile grid, near-white line work, drafted symbols, dimensions, a north arrow, a scale bar and a numbered drawing title. A robot's mind is drafted onto that plan as annotation: callout boxes on leaders, dashed sight and hearing circles, sound arcs labelled with their notes, and red-pen revision clouds where something needs attention. The inspector is the same paper, drawn as an attached sheet with a framed border, ruled schedules and a revision table.

The drawing is the only place that is diegetic. Every control is an ordinary web control (button, range slider, select, tab, table, drawer) dressed in the blueprint's type and colours, so it behaves the way the browser and assistive technology expect. The density is that of a working drawing: lots of information, kept legible by strict hierarchy of line weight and lettering rather than by cards or shadows.

The system rejects the default monitoring dashboard: a dark UI with a map widget and a sidebar of floating cards.

**Key Characteristics:**
- Flat blueprint paper in four close blues; depth comes from line weight and ruled frames, not shadow.
- Upright, tracked, uppercase drafting lettering (Overpass) for anything the drawing would letter; a plain, very legible sans (Atkinson Hyperlegible Next) for running text.
- One strong accent, the red pen, reserved for attention.
- Scene lettering is a fixed on-screen size at every zoom, never below about 12px, and hides rather than overprints.
- Phones turn the plan 90° to fill a tall screen and carry the inspector in a three-position drawer.

## Colors

A monochrome blueprint (paper blues and inks of one hue family) with a single warm red pen and a pale-yellow focus mark.

### Primary
- **Blueprint Sheet** (sheet): the paper itself. Background of the plan, the inspector sheet, the title block, legend, callout boxes and the default button fill. Also the knockout behind scene labels (at 90% opacity) so lettering sits on clean paper over the grid.

### Secondary
- **Red Pen** (red-pen): attention only. Revision clouds and their delta triangles in the scene, low-need gauges and battery, failed or rejected decisions, fallback rows, alert boxes, the disconnected status. Never decoration, never a brand colour, never a hover state.
- **Red Wash** (red-wash): the tint behind an alert box and a fallback row in the brain feed. Only ever paired with Red Pen text or border.

### Tertiary
- **Drafting Yellow** (focus): the keyboard focus ring and the replay playhead and lit timeline marker. It means "you are here", nothing else.

### Neutral
- **Deep Sheet** (sheet-deep): the frame around the drawing (top bar, timeline strip, sticky table headers), one step darker than the paper.
- **Raised Sheet** (sheet-raise): hover fill for buttons and table-row buttons; the lit row in the revision table.
- **Pressed Sheet** (sheet-press): active (mouse-down) fill.
- **Line Ink** (ink): primary text, object outlines, walls, callout frames, sheet and table borders, the pressed-toggle fill.
- **Secondary Ink** (ink-2): secondary lines and text: grid, paths, hatching, leaders, field values of lesser weight, scale labels, table headings.
- **Muted Ink** (ink-3): field keys, meta text, hints, inactive tabs, off gauge ticks. Lowest text tier; still 6.1:1 on the sheet.
- **Rule** (rule) and **Strong Rule** (rule-strong): translucent Secondary Ink for dividers. Rule separates rows inside a schedule; Strong Rule draws control borders, panel edges and title-block cells.

### Named Rules
**The One Red Pen Rule.** Red Pen is the only saturated colour and it marks something the owner should look at. If removing the red would not lose information, it should not be red.

**The Ink Ladder Rule.** Text and lines step down Ink, Secondary Ink, Muted Ink; nothing goes below Muted Ink. All three, Red Pen and Drafting Yellow clear WCAG 2.2 AA on every sheet blue used behind text (Muted Ink is lowest at 4.97:1 on Raised Sheet).

## Typography

**Display / Lettering Font:** Overpass (500, 600, 700), self-hosted; the middle dot (U+00B7) is borrowed from Atkinson Hyperlegible Next 700 through a "Draft Dot" face so `RB-02 · REST` spaces evenly.
**Body Font:** Atkinson Hyperlegible Next (400, 700), with system-ui fallback.

**Character:** Overpass is a highway-sign monoline close to ISO 3098 drafting lettering: upright, open, set in uppercase with positive tracking. Atkinson carries sentences (reasons, quotes, hints) where legibility beats atmosphere.

### Hierarchy
- **Display** (700, 2.5rem, line-height 1): the sheet/day number in the title block. One per screen.
- **Headline** (700, 1.625rem, 0.04em, uppercase): the selected robot's name in the inspector; 1.25rem on phones.
- **Title** (700, 1.125rem, 0.05em, uppercase): section headings, drawn with a heavy rule and a fine second rule beneath (a drafted double underline). The product name in the top bar uses this role.
- **Action** (700, 1.25rem, 0.02em, sentence case): the robot's current action. The one lettering role in mixed case, because it reads as a statement.
- **Body** (400, 0.9375rem, 1.45): the decision reason and running text.
- **Body small** (400, 0.8125rem): meta lines, hints, alerts, schedule cells.
- **Control** (600, 0.9375rem, 0.03em, uppercase): buttons, status chip, selects.
- **Value** (600, 0.9375rem, 0.03em, uppercase, tabular numerals): a field's value: title-block values (world, clock, tick, spend) and gauge percentages. Same size as Control but its own role, so changing button lettering never resizes the numbers on the sheet.
- **Label** (600, 0.8125rem, 0.04em, uppercase): legend entries, scale labels, table headings, title-block keys. Tabular numerals wherever numbers align.
- **Scene label** (600, 13px, 0.6px tracking): object names, robot tags, note chains drawn in Pixi. Grid references 12–13px; the drawing title 15px; alerts 13px at 700 in Red Pen.

### Named Rules
**The Constant Lettering Rule.** Scene text is set in screen pixels, not world units: zooming the plan never scales it. Minimum about 12px. When labels would collide at a zoom, they move to a clear candidate position on a leader, and if none is clear they hide; zooming in brings them back. Noise note labels always show; other labels make way for them.

**The Lettering vs Writing Rule.** If a draughtsman would letter it on the drawing (names, keys, values, headings, controls), it is Overpass uppercase. If it is a sentence, it is Atkinson in sentence case.

## Layout

Desktop (720px and up): a top bar (52px), then a two-column workspace, the sheet at 7fr and the inspector at 3fr (never under 400px). The scale-bar timeline runs under the sheet only. On the sheet, the title block sits bottom-right (up to 500px or 52% wide), the legend bottom-left, and the camera buttons stack top-right. The plan is fitted inside a drawing frame with margins for grid references above and left and the drawing title and scale bar below.

Phone (under 720px): the sheet fills the screen beneath a 50px top bar. The plan rotates 90° whenever the available area is more than 1.15 times taller than wide, so the long axis of the world follows the long axis of the phone; grid references and the north arrow rotate with it. The title block collapses into a compact boxed title in the top bar (world, day, clock), the legend and replay stamp move to the top of the sheet, and the timeline moves into the drawer. The inspector becomes a bottom drawer with three positions: closed (about 110px, the handle), peek (about 300px: handle, timeline, needs and current action) and full (88dvh). Selecting a robot while closed opens to peek. Top-bar buttons become 40×44px icon-only targets.

Spacing follows a 4px base (4, 8, 12, 16, 24, 32). Inspector sections pad 16px with 24px below; schedules use 4–6px cell padding for working-drawing density.

## Elevation & Depth

Flat. Every surface is paper on paper. Depth and grouping come from line weight and framing: a 1.5px Line Ink frame with a second 1px Strong Rule frame offset 3px outside it marks a sheet (the inspector), a 1.5px Line Ink border marks a drawn object (title block, callout, schedule), and Strong Rule marks a control or cell. The four sheet blues provide tonal steps for frame, paper, hover and press. There is no box-shadow vocabulary.

In the scene, line weight is the hierarchy: grid 1px at 11% (heavy every fifth line at 30%), paths dashed 1px, hatching 0.75px, walls and water edges 1.75px, object outlines 2–2.5px, callout frames 1.5px, leaders 1–1.25px, revision clouds 2px (3.5px when linked to the selected feed row).

### Named Rules
**The Paper-on-Paper Rule.** Nothing floats. If something needs to stand apart, draw a frame around it; do not lift it with a shadow.

## Shapes

Square, ruled geometry. Controls take a barely softened corner (4px); small tags, chips and row buttons 3px; the drawer grip 2px. The phone drawer's top edge rounds at 12px, the one large radius in the system, because it is a physical sheet pulled up from below. Drawn objects (title block, callouts, schedules, legend, stamp) are square-cornered. Double-rule borders (3px double) mark stamps. Dashed borders mean provisional or replayed: the replay status chip, the replay frame around the whole sheet, and noise note tags in the brain feed.

Icons are authored line drawings on a 24-unit grid, 1.75 stroke, round caps and joins, in currentColor, so they read as the same pen as the plan.

## Components

### Buttons
Standard buttons, lettered like the drawing.
- **Shape:** gently squared (4px), 1px Strong Rule border, 36px minimum height; icon buttons are 40px square.
- **Default:** Blueprint Sheet fill, Line Ink text in the Control role, 8px gap between icon and text.
- **Hover / Active:** Raised Sheet fill with a Secondary Ink border; Pressed Sheet on press. 160ms ease-out on colour only.
- **Toggled (aria-pressed):** inverted, Line Ink fill with Deep Sheet text. Used for Legend, Follow and similar on/off controls.
- **Ghost:** no fill or border until hover.
- **Disabled:** 45% opacity, not-allowed cursor.

### Status chip
Uppercase Control lettering in a 3px-cornered 1px Strong Rule box with an 8px ring before it: filled ring for live, dotted ring for connecting, dashed box for replay, Red Pen box and text for disconnected.

### Tabs
Text tabs on a Strong Rule baseline, 40px tall, Muted Ink at rest, Line Ink with a 2px Line Ink underline when selected. Counts sit in a 3px-cornered outlined tag.

### Inputs / Fields
- **Select:** 30px, Blueprint Sheet fill, Strong Rule border, 4px corner, Control lettering.
- **Timeline scale bar:** a native range input laid over a drafted scale bar (alternating filled and empty segments in a 1.5px Line Ink frame). The thumb is a T-shaped cursor in Line Ink, Drafting Yellow in replay. Day ticks and belief markers (small downward triangles, real buttons) sit along it.
- **Focus:** a 2px Drafting Yellow outline at 2px offset on every focusable element; the canvas shows an inset Drafting Yellow frame.

### Schedules and the revision table
Ruled tables with a 1.5px Line Ink outer border and header rule, 1px Strong Rule column rules in the header and Rule lines in the body. Headers are Label lettering in Secondary Ink on Deep Sheet, sticky. The brain feed is a revision table: each row opens with a revision button (delta triangle and number) that links to the matching revision cloud on the plan; the linked row lights in Raised Sheet.

### Need gauges
Tick-strip gauges: a row of 3px ticks above a Secondary Ink baseline, on ticks tall in Line Ink, off ticks short in Muted Ink, with a small triangle marking the low threshold. A gauge under threshold turns its label, value and ticks Red Pen.

### Alert
A Red Wash box with a 1.5px Red Pen border and 4px corner, Body small text in Line Ink and a Red Pen lead word.

### Title block (signature)
The drawing's title block, square and ruled: project row, then world, in-world time, tick, scale, thinking cost today and data source in Label keys over Overpass values, with the sheet/day number in Display in a heavy-ruled right column. Values wrap, never truncate.

### Scene annotation (signature)
Everything diegetic lives here, drawn in Pixi:
- **Callout:** a square 1.5px Line Ink box on a 1.25px leader, filled with 94% Blueprint Sheet, carrying name, mood, mini gauges and current action.
- **Sight and hearing circles:** dashed construction circles (6 on, 5 off), 1.25px Secondary Ink.
- **Sound arcs:** paired 1.75px Line Ink arcs either side of the robot's heading, one per note, expanding and fading; the note chain is lettered on a short leader and always visible.
- **Revision cloud:** a scalloped Red Pen cloud round the robot with a delta triangle and the revision number, lettered in Red Pen at 700.
- **Trails:** fine dashed Secondary Ink paths, fainter when not selected.
- **Drawing furniture:** grid references, overall dimensions in tiles, area hatching, a north arrow, a numbered drawing-title bubble with a double underline, and a scale bar.

### Phone drawer
A Blueprint Sheet panel with a 1.5px Line Ink top edge and 12px top corners, a centred 40×4px Muted Ink grip and a full-width 44px handle button that cycles closed, peek, full (or follows a vertical drag). Content is clipped, not scrolled, in closed and peek. 320ms ease-out transform.

## Do's and Don'ts

### Do:
- **Do** build every control from a native element (button, input range, select, table, tab with roles) and style it in Overpass and the sheet blues.
- **Do** keep scene lettering at a constant screen size, 12px or larger, on a 90% Blueprint Sheet knockout, and hide a label rather than shrink or overlap it.
- **Do** use Red Pen only for something that needs attention, and pair it with a shape or word so it never relies on colour alone.
- **Do** keep every text colour at 4.5:1 or better against the sheet blue behind it.
- **Do** give every played noise a lettered note chain on the plan.
- **Do** honour prefers-reduced-motion: transitions drop to 0ms, the camera jumps instead of easing, robots move without interpolation, and sound arcs draw as static concentric arcs at fixed radii instead of expanding.
- **Do** rotate the plan 90° on tall phone screens and put the inspector in the closed / peek / full drawer.

### Don't:
- **Don't** make controls diegetic: no drawn knobs, stamps or callouts that act as buttons outside the plan itself.
- **Don't** use Red Pen for decoration, branding, hover or selection.
- **Don't** lift anything with a drop shadow or put content in floating cards; frame it with rules instead.
- **Don't** scale scene text with zoom or let labels overprint.
- **Don't** introduce a second saturated hue.
