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

## Why the footer is not clickable today

`installFooter` hands Pi a plain object with `render` / `invalidate` / `dispose`.
It declares no layout node, so the box under the footer belongs to Pi's
`footerContainer`, whose `handleMouse` is `Container.prototype.handleMouse` — and
`dispatchMouseToLayout` skips exactly that case. A click on the footer therefore
lands nowhere. Starline's mouse suite patches only `TuiAltScreen` methods (mouse
routing, selection, copy, viewport input); the footer has never been part of it.

The same reason makes this cheap to add: nothing has to be unwound, only a node and
a hit map have to be declared.

## Design

### 1. The frame declares one leaf node

The footer component gains `[LAYOUT_NODE]()` returning a leaf whose height is the
rendered line count (1 for pill mode, 1–2 for the text footer). `handleMouse` then
receives `x` / `y` relative to the footer, and only events that actually land on a
pill are consumed.

Rejected: wrapping the footer in `MouseRegion`. It would work, but the wrapper needs
the same node declaration anyway, and starline renders its own hit map from the
same pass that renders the bar — two sources of truth for pill geometry is exactly
how these things drift.

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
| 1 | Layout node, pill span sink, action table, `/starline` action commands, one action (queue status → popover explaining what is queued) | M |
| 2 | Model picker via `ModelSelectorComponent` | M |
| 3 | Branch switcher (list local branches, confirm on a dirty worktree, `git checkout`) | M |
| 4 | Extension-status click hook: a status key opts in by publishing structured data | S–M |
| — | `pi-subagents` status bridge (separate package, no changes here) | S |

Phase 1 is the only one that touches rendering; phases 2–4 are actions added to a
table that already works, which is the point of doing it in that order.

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
