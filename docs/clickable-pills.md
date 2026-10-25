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

| Pill | Click |
| --- | --- |
| queue indicator | list what is queued (steering / follow-up) |
| thinking level | step to the next level the model supports |
| model | pick a model, reusing Pi's own selector component |
| git branch | switch branch, after a dirty-worktree check |
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
  `dispatchMouseToLayout` skips is the narrower case of a component that *does*
  declare a node and still uses `Container.prototype.handleMouse`, because there
  the box is the whole container rather than one leaf. Pi's footer slot is a plain
  `Container`, so it is a box, it is dispatched to, and its `handleMouse` forwards
  into the footer with `y` rebased.
- **`MouseRegion`** (`components/mouse-region.js`) is the documented way to add
  pointer behaviour to an existing component: it renders the child, forwards the
  event to it first, and only then calls its own handler.
- **`ctx.ui.custom(factory, { overlay: true })`** opens a focused component on top
  of everything — the popover primitive, no layout work needed.
- **`ModelSelectorComponent`** is exported from `@earendil-works/pi-coding-agent`, so
  the model picker can be Pi's own instead of a look-alike.
- **`ctx.ui.setStatus(key, text)`** is how another extension publishes a pill
  today; `extensionStatus:<key>` in `pill.segments` already renders one. A bridge
  for `pi-subagents` (which never calls `setStatus`) is a ~30 line extension with
  **zero** changes here.
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

**As built:** the handler also claims `press`. Pi synthesizes a `click` only when a
component accepted the `press` first, so an action cannot run on `click` alone. The
press runs nothing; the action fires on the click, which Pi produces only when press
and release landed on the same cell. A gesture that turns into a drag never becomes
a click, which is the cheap half of the accidental-click risk below.

Rejected: `MouseRegion`. It is the right tool when a handler wants to wrap
*someone else's* component; here the footer and the handler are the same object,
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

The queue bubble, the branch switcher and any future panel open through
`ctx.ui.custom(..., { overlay: true })`. The footer stays one line; nothing about
the layout changes when a popover is open.

**As built:** the popover grows up out of the pill it belongs to, like a menu out of
a menu bar. `pill-bubble.ts` is the shared component: an action passes its content
plus the `PillAnchor` the footer recorded for that pill (first coloured column,
centre column, terminal width, the pill's own background and foreground SGR), and
gets a block in the pill's colours. Placement is `anchor: "bottom-left"` +
`offsetX` at the pill's first coloured column and `offsetY: -1`, so the block's last
row sits directly on the footer row and the colour runs from the bubble into the
pill. Near the right edge the block shifts left just enough to stay on screen.
Without an anchor — the `/starline` command when the pill is not drawn — it
centres and floats. Opening a second bubble closes the first, so clicking another
pill swaps the popover instead of stacking overlays.

The shape is a square block on purpose. A terminal colours whole cells, so rounded
corners and a pointing tail can only be faked with glyphs, and three attempts
(box-drawing corners over a fill, quadrant-cut corners `▗ ▖ ▝ ▘`, a `▼` tail on its
own row) all left seams where the glyphs met the fill. Colour plus adjacency says
which pill a bubble belongs to without any of that. The only shaping is a half-block
row (`▄`) on top — and `▀` underneath when floating — which halves the padding and
cannot misalign.

The panel closes on Escape (and Enter) through its own `handleInput`. Pi owns the
overlay, but not the meaning of Escape inside it, so the dismiss key is part of the
component rather than something the overlay stack does for us.

## A protocol for other extensions

Starline already draws other extensions' status pills (`ctx.ui.setStatus(key, text)`
rendered by the `extensionStatus` segment). The protocol is the other half: the
owning extension says what a click means, and gets the same bubble without
rendering or positioning anything.

**As built:** Starline publishes an object on `globalThis` under
`Symbol.for("pi-starline.pill-api.v1")`. A global symbol rather than an import, for
the same reason `@xzzpig/pi-mouse-events` uses one: load order is not controlled by
either side, and an extension should not depend on a package that may be loaded
twice.

```ts
const api = globalThis[Symbol.for("pi-starline.pill-api.v1")];

api?.register("pi-balance", ({ ctx, pill }) => {
  api.showBubble(
    ctx,
    {
      title: "Balance",
      body: [
        "5h: 42% left",
        "7d: 12% left",
        {
          text: "▸ 7-day breakdown",
          onSelect: () => api.showBubble(ctx, { title: "7d", body: ["Mon 3%", "Tue 2%"] }, pill),
        },
      ],
      hint: "esc to close",
    },
    pill,
  );
});
```

- The key is the status key, which is also the pill's span key, so no extra
  mapping is needed. Starline's own segment names win over a bridge, so a status
  cannot hijack `queue`.
- `pill` is the anchor the footer recorded for that pill (centre column, terminal
  width, its colours). Passing it through is what makes the bubble point at the
  right pill; omit it and the bubble centres.
- A body entry as an object is a target: it renders underlined, and a click runs
  `onSelect` and closes the bubble. A callback that opens another bubble replaces
  the first, which is how a breakdown view works.
- Register from `session_start`: it runs after every extension in the process has
  loaded, so the API exists whatever the load order. `/reload` re-runs it, so the
  bridge survives a reload — and re-registering replaces the old action.
- The same action is reachable from the keyboard as `/starline <key>` (for
  example `/starline pi-balance`), because the command path resolves through the
  same table. The context's `via` says which way it came (`"click"` or
  `"command"`); a bubble's targets need a pointer, so an action that offers
  choices can act directly from the command instead.

`register` returns an unregister handle; a stale handle cannot remove a newer
registration for the same key. `scripts/balance-probe.ts` in the working tree is a
stand-in for `pi-balance` used to exercise this end to end.

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

## Hiding Pi's own queue rows

Pi draws `Steering: …` rows and a dequeue hint above the editor from
`InteractiveMode.updatePendingMessagesDisplay`, and no extension API reaches that
container. `queue-rows.ts` wraps the method through the registry: while the queue
pill is actually in the bar (`footerStyle: "pill"`, `pill.segments` contains
`queue`, status line on), it clears the container instead of refilling it. The
predicate is read on every queue update, so the rows return the moment the pill is
configured away — no restart, and no key to remember.

Both wrappers are meant to be temporary. The upstream fix is a `pendingMessages`
field on the extension context plus a switch for the rows; `live-session.ts` and
`queue-rows.ts` then go away without touching the bubble.

## Phasing

| Phase | Content | Effort |
| --- | --- | --- |
| 1 ✅ | Footer `handleMouse`, pill span sink, action table, `/starline` action commands, speech-bubble popover, two actions (queue status → bubble listing what is queued; thinking level → pick from the list, or step from the command) | M |
| 2 | Model picker via `ModelSelectorComponent` | M |
| 3 | Branch switcher (list local branches, confirm on a dirty worktree, `git checkout`) | M |
| 4 ✅ | Extension-status click hook: a status key opts in by publishing structured data — shipped as the published pill API, which also covers `pi-subagents` and any other extension | S–M |
| — | `pi-subagents` status bridge (separate package, no changes here) | S |

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
  extensions that need to watch the mouse *globally*, which is not this.
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
  click. **As built:** Pi synthesizes a click only when press and release land on
  the same cell, and the press itself runs nothing, so a gesture that slides off the
  pill it started on never fires. `test/pill-click.test.ts` pins the press/click
  split.
- **Which segments are safe to make clickable.** `gitStatus`, `tokens` and `context`
  are read-outs; a click that does nothing is worse than an inert pill, so they
  stay inert until there is something to show.
- **The session capture is a patch.** `AgentSession.prompt` and `getContextUsage`
  are public and the wrappers only record `this`, and `updatePendingMessagesDisplay`
  is public too, but a future Pi could move the queue or rename the container. The
  wrappers are installed through the registry with guards and the bubble falls back
  to the boolean text, so the failure mode is a less detailed bubble rather than a
  broken pill.
- **Terminal mouse reporting is per-frame.** A terminal that drops mouse reporting
  (some multiplexers) leaves the pills dead but harmless: no keyboard path is
  removed, so the feature degrades to today's behaviour.
