# Clickable pills — design note

Status: **phase 1 implemented, plus the bridge for other extensions.** The footer
has a `handleMouse`, the pill renderer records hit areas and colours, actions live
in one table, and the queue pill plus `/starline queue` are the first (mouse +
keyboard) pair. Popovers are a shared speech bubble that points at the pill it
belongs to, bubble rows can be clickable, and any extension can register an action
for its own status pill through a published API. Phases 2–4 add content rather than
plumbing.

This document was written before the code so the pieces could be argued about
separately. Paragraphs marked **As built** were corrected against Pi 1.4.0 while
implementing phase 1.

## Goal

Make the footer interactive without making it fragile:

1. A click on a pill runs an action that belongs to that pill's segment.
2. The same action is reachable from the keyboard, always. A footer that can only
   be driven with a mouse is a footer half the users cannot use.
3. The action surface is per-segment and optional: a pill with no action stays a
   label and swallows nothing.

Four actions motivated this, in the order they are worth building:

| Pill                 | Click                                                     |
| -------------------- | --------------------------------------------------------- |
| queue indicator      | list what is queued (steering / follow-up)                |
| thinking level       | step to the next level the model supports                 |
| model                | pick a model, reusing Pi's own selector component         |
| git branch           | switch branch, after a dirty-worktree check               |
| any extension status | let the extension decide (at minimum: show its full text) |

Thinking was not in the original four: it arrived second because the pill is on
screen from the first frame, which makes it the honest way to check that a click
works without staging anything.

## What Pi already provides

- **Mouse dispatch goes through the layout tree.** `TuiAltScreen.handleMouseEvent`
  → `dispatchMouseToLayout` walks the boxes under the pointer and calls
  `component.handleMouse(event)` with coordinates relative to that component's box
  (`tui-alt-screen.js:644`).

  **As built:** every entry of a `vstack`/`hstack` gets a box, with or without a
  layout node (`layoutComponent` in `layout.js`); a component that declares no
  `[LAYOUT_NODE]()` simply gets a box with no children of its own. What
  `dispatchMouseToLayout` skips is the narrower case of a component that _does_
  declare a node and still uses `Container.prototype.handleMouse`, because there
  the box is the whole container rather than one leaf. Pi's footer slot is a plain
  `Container`, so it is a box, it is dispatched to, and its `handleMouse` forwards
  into the footer with `y` rebased.
- **`MouseRegion`** (`components/mouse-region.js`) is the documented way to add
  pointer behaviour to an existing component: it renders the child, forwards the
  event to it first, and only then calls its own handler.
- **`ctx.ui.custom(factory, { overlay: true })`** opens a focused component on top
  of everything — the popover primitive, no layout work needed.
- **`ctx.scopedModels`** is the set ctrl+p cycles (`enabledModels` / `--models`), and
  `pi.setModel` switches. The model picker lists those in the bubble rather than
  embedding Pi's full `ModelSelectorComponent`: a handful of models is what fits a
  bubble, and `/model` is still there for the whole catalogue.
- **`ctx.ui.setStatus(key, text)`** is how another extension publishes a pill
  today; `extensionStatus:<key>` in `pill.segments` already renders one.
  `pi-subagents` never calls `setStatus`, but it publishes a versioned in-process
  RPC on `pi.events`, which is what the built-in `subagents` pill reads (below).
- **A `Container` forwards to its children.** `Container.handleMouse` (`tui.js:116`)
  walks its children by rendered height and re-dispatches with `y` rebased to the
  child, `x` unchanged. A component mounted inside one of Pi's container slots —
  footer, widget, status — therefore receives clicks without declaring a layout
  node of its own. Verified against 1.4.0: a two-row container delivers
  `{x: 7, y: 0}` to its second child for a click at `{x: 7, y: 1}`, and delivers
  nothing to that child for a click on the first row.

## Why the footer was not clickable before phase 1

`installFooter` hands Pi a plain object with `render` / `invalidate` / `dispose`
and no `handleMouse`. Pi's `footerContainer` would forward a click to it — the
container does that for every child — but there was nothing to forward to, so the
event stopped at the container. Nothing had to be patched for it either: the
handler simply did not exist.

## Design

### 1. The footer component implements `handleMouse`

No layout node, no wrapper. The footer already owns the one line it renders, and
Pi's container rebases `y` into it, so `handleMouse(event)` receives exactly the
coordinates the pill spans are measured in. An event that lands on no pill returns
`undefined`, so a click on empty footer space falls through and swallows nothing.

**As built:** the handler also claims `press`, and the action runs _on that press_.
Waiting for Pi's synthesized `click` would put the whole button-hold in front of the
bubble: a click is press + release + synth, and for a target one row tall that hop
is pure added latency. Because Pi synthesizes a click for every press that did not
move and delivers it to the same component, the handler remembers which pill it just
acted on and swallows that one click, so a single press cannot toggle the bubble it
opened. A press that turns into a drag can still have opened something, so the drag
closes it again; the threshold is two columns, which is past any jitter and short of
any selection a user meant to start. `test/pill-click.test.ts` pins all three
branches: press acts, the following click is swallowed, a drag undoes.

Rejected: `MouseRegion`. It is the right tool when a handler wants to wrap
_someone else's_ component; here the footer and the handler are the same object,
and the extra layer would only separate the hit map from the render that produced
it.

### 2. The renderer records the pill spans

`renderPillBar` already concatenates pills one at a time; it gains an optional
sink that records `{ key, startColumn, endColumn }` per pill as it goes. The hit map
is therefore produced by the render that is actually on screen, including
truncation: a pill clipped away by `width` is simply not in the map, and a pill
clipped in the middle still answers for its visible cells.

The map is stored on the footer instance, replaced on every render, and read only
by `handleMouse`. No timers, no invalidation logic.

**As built:** spans are keyed by render width, not "the last render", because a
render is also how the layout measures; one frame can render the footer at more
than one width and the map a click is matched against has to be the one that was
drawn. A span covers the pill's own padding, the separator that points out of it,
and the end caps, so the bar has no dead cells between two pills. Columns come from
`visibleWidth`, never `string.length`, because segment text can be CJK.

**As built:** an extension status pill's span key is still the status key, so the
action lookup only answers for builtin segment names. A third-party status that
happens to be called `queue` stays inert instead of opening Starline's panel.

### 3. Actions are a table, keyed by segment

```ts
type PillAction = (context: PillActionContext) => void | Promise<void>;
const PILL_ACTIONS: Readonly<Partial<Record<string, PillAction>>> = { … };

/** Builtin segments only: an extension status pill carries its status key. */
export function pillActionFor(key: string): PillAction | undefined;
```

- A segment with no entry is inert: the click is not handled, so Pi's own handling
  (if any) continues.
- The table lives next to the segment list rather than inside each renderer, so
  "which pills do something" is one screen of code.
- Every action also gets a slash command (`/starline queue`, `/starline model`, …),
  which is what makes the keyboard path real rather than aspirational. Reusing
  starline's existing `/starline` plumbing keeps this cheap.

### 4. Popovers are overlays, not layout

The queue bubble, the model and thinking pickers and any future panel open through
`ctx.ui.custom(..., { overlay: true })`. The footer stays one line; nothing about
the layout changes when a popover is open.

**As built:** the popover is a rounded outline in the pill's colour whose bottom
edge opens over the pill, like a folder tab, so the pill reads as its handle.
`pill-bubble.ts` is the shared component: an action passes its content plus the
`PillAnchor` the footer recorded for that pill (the pill's coloured columns, centre
column, terminal width, background and foreground SGR). Placement is
`anchor: "bottom-left"`, `offsetX` three columns left of the pill and
`offsetY: -1`, so the bottom edge sits directly on the footer row and breaks over
the pill's columns (`╰──┘ ⋯ └──╯`). Near the right edge the box shifts left just
enough to stay on screen; when that leaves no edge beside the pill, the bottom
closes instead. Without an anchor — the `/starline` command when the pill is not
drawn — it centres with a closed bottom. Opening a second bubble closes the first, so clicking another
pill swaps the popover instead of stacking overlays; clicking the same pill again
closes its bubble, like a menu-bar item. The anchor carries the pill's key for
that.

**Clicking away.** A press anywhere else on the screen closes the bubble, and the
press is still delivered: it moves the caret in the editor, drops a selection in
the transcript, or does whatever it would have done with no bubble open. The
rectangle it is matched against is the one the bubble drew (`PillBubbleGeometry`,
recorded on every render), resolved against the terminal's current height, so a
window that grew keeps the bubble on its footer. The footer row is decided by the
footer itself, cell by cell: a press on a clickable pill keeps its own meaning
(the same pill closes the bubble, another pill replaces it), and a press on the
bar's padding, a gap between pills, or a pill that is only a read-out closes it
like the rest of the screen. Closing there from the geometry check as well would
make the same pill's second click close and immediately reopen. The press is read where every pointer
report arrives, at the `handleMouseEvent` patch that already drives the hand
pointer, through `mouse/pointer-events.ts`: the bubble does not take a second
patch on the same method. It follows `mouse.enabled`, the same switch as the hand
pointer, so with Starline's mouse features off Escape and the pill remain the ways
out.

**Live bubbles.** `showPillBubble` takes the content or a function returning it, and
returns a handle (`refresh`, `close`, `isOpen`, `onClose`). A refresh re-reads the
function and repaints through the overlay's own `requestRender`. Pi fixes an
overlay's width when it opens, so a refresh whose content no longer fits mounts a
wider overlay in the same place and only then dismisses the narrower one, so there
is never a frame without a bubble; it never narrows while open, which would make it
jitter. Starline does not poll the function: the owner calls `refresh()`. The queue
and subagents bubbles tick once a second while open (the subagents one asks
pi-subagents again each tick, skipping a tick while an answer is outstanding), and
every way a bubble ends runs `onClose` exactly once, which is where the timer stops.

**Why an outline.** A terminal colours whole cells, so a rounded corner drawn over
a fill leaves the fill's square corner around the curve. Four filled versions were
tried and dropped (box-drawing corners over a fill, quadrant-cut corners
`▗ ▖ ▝ ▘`, a `▼` tail, a plain block on the pill). With nothing filled, `╭ ╮ ╰ ╯`
are simply round, and the inside keeps the terminal's own background — which on a
translucent terminal shows the blurred window behind it. Colour goes on the
outline, the title (which rides in the top edge, `╭─ Thinking ─╮`) and the selected
row. All of the look is in `buildBubble()`; placement, targets, refresh and the
protocol do not depend on it. Other directions considered (soft tint, dark card with
an accent strip, a rail, stacked pills, a drop shadow, real pixels through the kitty
graphics protocol) were compared in a gallery before choosing.

**Choosing a target.** The mouse and the keyboard move one selection: hovering a
target selects it, ↑/↓ step through the targets (wrapping), Enter runs the selected
one or closes the bubble when none is selected, Escape closes. A target marked
`current` (the active level or model in a picker, which is a target for exactly
this reason) is selected when the bubble opens, so ↑ from `high` lands on `medium`;
the selection follows that mark through refreshes until the user moves it. The selected row is
filled with the pill's colour, like a menu highlight. Pi owns the overlay but not
the meaning of keys inside it, so these are the component's own `handleInput`.

**Opening.** The first overlay unfolds upward from the pill over 60 ms
(`pill.bubbleAnimation`, on by default): it is anchored at its bottom, so drawing
only its last rows and adding one per frame grows it out of the pill. Rows not yet
drawn are not clickable. A reopen for width is not animated.

### 5. The pointer becomes a hand over a target

Moving over a pill with an action, or over a clickable bubble line, switches the
mouse pointer to a hand through OSC 22 (`ESC ] 22 ; pointer ST`, CSS cursor names;
Ghostty and kitty honour it, other terminals ignore it). Pi already delivers every
pointer movement to the component under it as a `move` (any-motion tracking; under
tmux, zellij and screen it only reports with a button held, so there is no hover).

The missing half is _leaving_: Pi has no leave event, and the move after the last
one over a pill goes to whatever is under the pointer now. So the shape is not the
footer's to manage. `mouse/pointer-shape.ts` wraps `TuiAltScreen.handleMouseEvent`;
during a `move` a component calls `requestPointerShape("pointer")`, and after the
dispatch a move nobody claimed resets to `default`. Only changes are written. The
wrapper is uninstalled, and the pointer reset, on shutdown and on process exit.

**As an upstream API** this is a field on `TuiMouseEventResult` — a component's
`handleMouse` returns `{ handled: true, pointer: "pointer" }` and the renderer owns
OSC 22, the reset on an unclaimed move, and the reset on exit. That would also give
Pi's own click targets (tool boxes, thinking blocks, summaries) a hand pointer and
the editor a text cursor. When it ships, the two callers return the field and the
wrapper is deleted.

## A protocol for other extensions

Starline already draws other extensions' status pills (`ctx.ui.setStatus(key, text)`
rendered by the `extensionStatus` segment). The protocol is the other half: the
owning extension says what a click means, and gets the same bubble without
rendering or positioning anything.

**As built:** Starline publishes an object on `globalThis` under
`Symbol.for("pi-starline.pill-api.v1")` with `register(key, action)` and
`showBubble(ctx, content, pill)`. How to use it, with templates for an extension's
own pill and for a bridge to someone else's, is in [pill-api.md](pill-api.md); the
types ship as `types/pill-api.d.ts`, which Starline's own code also imports, so the
published shapes and the implementation cannot drift.

The design choices behind it:

- **A global symbol, not an import.** Load order is not controlled by either side,
  and an extension should not depend on a package that may be loaded twice; the
  same reason `@xzzpig/pi-mouse-events` publishes one. Without Starline the lookup
  is `undefined` and the caller's `?.` skips everything.
- **The newest object wins.** Starline publishes when its module loads, before any
  `session_start`, and bridges register from `session_start`. Replacing an older
  object therefore never loses a registration, while keeping it would, after a
  `/reload` that re-imports the module, leave bridges registering into the previous
  module's registry while the new footer reads its own.
- **The key is the status key**, which is also the pill's span key, so no mapping
  is needed. Starline's own segment names win, so a status cannot hijack `queue`.
- **Additive, still v1.** The handle, the function content and `via` were added
  without breaking a v1 caller: an older Starline returns nothing from
  `showBubble`, which a caller detects with `handle?.`.

`scripts/balance-probe.ts` in the working tree is a stand-in for `pi-balance` used to
exercise this end to end.

## What the queue bubble shows

`ctx.hasPendingMessages()` is a boolean, but the data behind it is public on
`AgentSession`: `pendingMessageCount`, `getSteeringMessages()`,
`getFollowUpMessages()`. What interactive mode does not hand out is the session
instance — the context has the session manager, not the session.

**As built:** `live-session.ts` captures the instance from two methods the footer
already reaches — `getContextUsage()` on every render, and `prompt()` for a queue
that predates Starline loading — through the same prototype-patch registry the
mouse layer uses. The queue bubble then lists the count and up to three messages,
followed by `+N more`. When neither wrapper is in place (older Pi) the bubble
falls back to explaining the wait, and the pill still says `queued`.

The same captured session drives the thinking action. A click opens a list of
every level from `getAvailableThinkingLevels()`, minus `off` so the pill cannot
click itself off the screen; the current level is marked, the others are targets
that call `setThinkingLevel()`. Opening the list changes nothing. `/starline
thinking` has no pointer to pick with, so it steps to the next level instead and
reports `from → to`.

## The subagents pill

`pi-subagents` draws its own FleetView and widget and publishes no status, so there
is nothing for a bridge to hang off. What it does publish is an in-process RPC on
`pi.events` (`subagents:rpc:v1`, documented in its `docs/extension-api.md`): an
untargeted `status` request answers from in-memory state with a versioned `fleet`
record — every active run, foreground and background, with agent, step label,
model, effort, start time and tokens.

Because that RPC is a published contract, the pill is built in rather than asking
the package to adopt the pill API. `subagent-fleet.ts` sends `status` and caches the
answer; it asks again on the package's lifecycle events (`subagent:async-started`,
`-complete`, `foreground-complete`, `child-status`, …) and on Pi's
`tool_execution_start`/`end` for the `subagent` tool, since a foreground run starts
with no event of its own. Bursts collapse into one request, there is no timer, and
the footer only redraws when the count changes. A click asks once more (400 ms,
then the cached answer), and the open bubble asks again every second so elapsed
times, tokens and the list stay current until it closes. Without pi-subagents the
requests go unanswered and the pill never appears.

Verified against pi-subagents 0.82.0: the same request from a probe extension gets
`{ success: true, data: { fleet: { version: 1, entries, totalActive, omitted } } }`.

## Hiding Pi's own queue rows

Pi draws `Steering: …` rows and a dequeue hint above the editor from
`InteractiveMode.updatePendingMessagesDisplay`, and no extension API reaches that
container. `queue-rows.ts` wraps the method through the registry: while the queue
pill is actually in the bar (`pill.segments` contains
`queue`, status line on), it clears the container instead of refilling it. The
predicate is read on every queue update, so the rows return the moment the pill is
configured away — no restart, and no key to remember.

Both wrappers are meant to be temporary. The upstream fix is a `pendingMessages`
field on the extension context plus a switch for the rows; `live-session.ts` and
`queue-rows.ts` then go away without touching the bubble.

## Phasing

| Phase | Content                                                                                                                                                                                                                           | Effort |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1 ✅  | Footer `handleMouse`, pill span sink, action table, `/starline` action commands, speech-bubble popover, two actions (queue status → bubble listing what is queued; thinking level → pick from the list, or step from the command) | M      |
| 2 ✅  | Model picker: the session's scoped models in the bubble, switched with `pi.setModel`                                                                                                                                              | S      |
| 3     | Branch switcher (list local branches, confirm on a dirty worktree, `git checkout`)                                                                                                                                                | M      |
| 4 ✅  | Extension-status click hook: a status key opts in by publishing structured data — shipped as the published pill API, which also covers `pi-subagents` and any other extension                                                     | S–M    |
| 5 ✅  | `subagents` pill: count of running subagents, bubble listing them, read from pi-subagents' public RPC                                                                                                                             | S      |

Phase 1 was the only phase that touched rendering; phases 2–4 are actions added to a
table that already works, which is the point of doing it in that order. Phase 1
landed as `extensions/starline/pill-actions.ts` (the table and the queue action),
`pill-bubble.ts` (the shared popover), `PillSpan` in `pill.ts`, and `handleMouse` in
`footer.ts`, with `live-session.ts` as the temporary bridge to the queue contents.
Phase 4 landed as `pill-api.ts`, and a bridged status pill is exercised end to end by
`scripts/balance-probe.ts`.

## What this does not need

- **No `@xzzpig/pi-mouse-events`.** That extension patches `TuiAltScreen` to
  expose a global mouse channel with screen coordinates. A component that renders
  its own pills gets precise, already-rebased events from Pi's own dispatch, so the
  channel would be a worse source for the same information. It stays useful for
  extensions that need to watch the mouse _globally_, which is not this.
- **No layout work.** The footer is one line and an overlay is composited on top;
  neither the hit map nor the bubble declares a layout node.
- **No upstream API for rendering.** Everything in that half is public surface in
  Pi 1.4. Reading the queued messages is the one exception, and it is a transitional
  wrapper (`live-session.ts`) rather than a dependency on internals.

## Risks and open questions

- **Click targets on a narrow footer.** At 60 columns the queue pill may be
  truncated to two cells. **As built:** a partially visible pill is still a target
  for its visible cells; a pill clipped away entirely is not in the map at all.
- **Accidental clicks while selecting.** The footer sits below the editor, so a
  drag that starts in the transcript and ends on the footer is a selection, not a
  click. **As built:** the press runs the action, so a gesture that _starts_ on a
  pill opens it before it becomes anything else — the drag branch closes it again
  once the pointer has moved more than two columns, and a gesture that slides onto
  the footer and releases there never fires at all, since no press landed on the
  pill. `test/pill-click.test.ts` pins the press/click/drag split.
- **Which segments are safe to make clickable.** `tokens` and `context` are
  read-outs; a click that does nothing is worse than an inert pill, so they stay
  inert until there is something to show. The `git` pill lists the changed paths,
  read-only: no staging, no branch switch, because an agent may be running in the
  same tree.
- **The session capture is a patch.** `AgentSession.prompt` and `getContextUsage`
  are public and the wrappers only record `this`, and `updatePendingMessagesDisplay`
  is public too, but a future Pi could move the queue or rename the container. The
  wrappers are installed through the registry with guards and the bubble falls back
  to the boolean text, so the failure mode is a less detailed bubble rather than a
  broken pill.
- **Terminal mouse reporting is per-frame.** A terminal that drops mouse reporting
  (some multiplexers) leaves the pills dead but harmless: no keyboard path is
  removed, so the feature degrades to today's behaviour.
