# Clickable pills — design note

Status: not implemented. This is the design and the survey behind it, written
before any code so the pieces can be argued about separately.

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
  (`tui-alt-screen.js:644`). A box is only created for a component that declares
  `[LAYOUT_NODE]()` (`layout-node.js`, `layout.js:50`); anything else is folded into
  its parent's box.
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

## Why the footer is not clickable today

`installFooter` hands Pi a plain object with `render` / `invalidate` / `dispose`
and no `handleMouse`. Pi's `footerContainer` would forward a click to it — the
container does that for every child — but there is nothing to forward to, so the
event stops at the container. Nothing is patched, nothing is in the way: the
handler simply does not exist yet.

## Design

### 1. The footer component implements `handleMouse`

No layout node, no wrapper. The footer already owns the one line it renders, and
Pi's container rebases `y` into it, so `handleMouse(event)` receives exactly the
coordinates the pill spans are measured in. An event that lands on no pill returns
`undefined`, so a click on empty footer space falls through and swallows nothing.

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

### 3. Actions are a table, keyed by segment

```ts
type PillAction = (context: PillActionContext) => void | Promise<void>;
const pillActions: Partial<Record<PillSegmentKey, PillAction>> = { … };
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
the layout changes when a popover is open, and `Escape` closes it through Pi's own
overlay handling.

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
| 1 | Footer `handleMouse`, pill span sink, action table, `/starline` action commands, one action (queue status → popover explaining what is queued) | M |
| 2 | Model picker via `ModelSelectorComponent` | M |
| 3 | Branch switcher (list local branches, confirm on a dirty worktree, `git checkout`) | M |
| 4 | Extension-status click hook: a status key opts in by publishing structured data | S–M |
| — | `pi-subagents` status bridge (separate package, no changes here) | S |

Phase 1 is the only one that touches rendering; phases 2–4 are actions added to a
table that already works, which is the point of doing it in that order.

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
  truncated to two cells. Decide whether a partially visible pill is still a
  target (proposal: yes, for its visible cells).
- **Accidental clicks while selecting.** The footer sits below the editor, so a
  drag that starts in the transcript and ends on the footer is a selection, not a
  click; Pi only synthesizes a click when press and release land on the same cell.
  Nothing to build, but it belongs in the tests.
- **Which segments are safe to make clickable.** `gitStatus`, `tokens` and `context`
  are read-outs; a click that does nothing is worse than an inert pill, so they
  stay inert until there is something to show.
- **Terminal mouse reporting is per-frame.** A terminal that drops mouse reporting
  (some multiplexers) leaves the pills dead but harmless: no keyboard path is
  removed, so the feature degrades to today's behaviour.
