# Clickable pills — design note

Status: **phase 1 implemented.** The footer has a `handleMouse`, the pill renderer
records hit areas, actions live in one table, and the queue pill plus
`/starline queue` are the first (mouse + keyboard) pair. Phases 2–4 are still
design, and each of them is now an entry in that table rather than new plumbing.

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
| model | pick a model, reusing Pi's own selector component |
| git branch | switch branch, after a dirty-worktree check |
| any extension status | let the extension decide (at minimum: show its full text) |

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

The queue list, the branch switcher and any future panel open through
`ctx.ui.custom(..., { overlay: true })`. The footer stays one line; nothing about
the layout changes when a popover is open.

**As built:** the panel closes on Escape (and Enter) through its own `handleInput`.
Pi owns the overlay, but not the meaning of Escape inside it, so the dismiss key is
part of the component rather than something the overlay stack does for us.

## The two things that cannot be built yet

1. **A queued-message count.** The public surface is
   `ctx.hasPendingMessages(): boolean`. The count and the messages themselves live
   on `AgentSession` (`pendingMessageCount`, `getSteeringMessages()`,
   `getFollowUpMessages()`), which interactive-mode does not put on the extension
   context, and there is no queue event to reconstruct them from. A pill can show
   `queued` truthfully; a number needs an upstream change (a `pendingMessageCount`
   on `ctx` would do).
2. **Hiding Pi's own pending-messages rows above the editor.** That is Pi's
   `pendingMessagesContainer`; no extension API reaches it. Doing it from here means
   patching Pi's renderables by position, the same class of hack the fixed-editor
   era ran on. Recommendation: leave Pi's rows alone until Pi offers a switch, and
   add the pill as an *additional* signal rather than a replacement.

## Phasing

| Phase | Content | Effort |
| --- | --- | --- |
| 1 ✅ | Footer `handleMouse`, pill span sink, action table, `/starline` action commands, one action (queue status → popover explaining what is queued) | M |
| 2 | Model picker via `ModelSelectorComponent` | M |
| 3 | Branch switcher (list local branches, confirm on a dirty worktree, `git checkout`) | M |
| 4 | Extension-status click hook: a status key opts in by publishing structured data | S–M |
| — | `pi-subagents` status bridge (separate package, no changes here) | S |

Phase 1 was the only phase that touched rendering; phases 2–4 are actions added to a
table that already works, which is the point of doing it in that order. Phase 1
landed as `extensions/starline/pill-actions.ts` (the table and the queue action),
`PillSpan` in `pill.ts`, and `handleMouse` in `footer.ts`.

## What this does not need

- **No `@xzzpig/pi-mouse-events`.** That extension patches `TuiAltScreen` to
  expose a global mouse channel with screen coordinates. A component that renders
  its own pills gets precise, already-rebased events from Pi's own dispatch, so the
  channel would be a worse source for the same information. It stays useful for
  extensions that need to watch the mouse *globally*, which is not this.
- **No new prototype patch.** The whole feature is one method on a component
  Starline already owns.
- **No upstream API.** Everything above is public surface in Pi 1.4.

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
- **Terminal mouse reporting is per-frame.** A terminal that drops mouse reporting
  (some multiplexers) leaves the pills dead but harmless: no keyboard path is
  removed, so the feature degrades to today's behaviour.
