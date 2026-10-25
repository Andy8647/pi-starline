# Clickable pills for other extensions

Starline draws other extensions' statuses as pills in its footer. With the pill
API, a click on one of those pills opens Starline's popover with whatever that
extension wants to show: a breakdown, a list, a few actions.

There are two ways to use it:

- **[You own the extension](#1-your-own-extension):** add about ten lines to it.
- **[It is someone else's extension](#2-someone-elses-extension-a-bridge):** write
  a small bridge extension that reads what that extension already publishes.

Neither needs Starline as a dependency. The API is found on `globalThis`, so an
extension that uses it still loads, and does nothing extra, when Starline is not
installed.

## What a pill gets

- A click opens a bubble: a rounded outline in the pill's colour that opens over
  the pill like a folder tab, your title in its top edge. A second click on the
  same pill closes it, and so does Escape.
- Body lines can be targets: underlined, the pointer turns into a hand over them,
  and the row under the pointer is highlighted in the pill's colour. ↑/↓ move the
  same highlight and Enter runs it; a click runs it too. Mark the target that is
  the present state with `current: true` (the active option in a picker) and the
  bubble opens with it highlighted, so the arrows move from there.
- The content can be live: the bubble re-reads it while open.
- The same action runs from the keyboard as `/starline <key>`.

## How a status becomes a pill

The pill is your extension's status, published with Pi's own
`ctx.ui.setStatus(key, text)`. The API makes it clickable; it does not create it.
For the pill to show up:

- The user's footer is the pill style (`footerStyle: "pill"`, the default).
- `pill.segments` contains `extensionStatus` (the default list does), which
  expands to every status, or `extensionStatus:<your key>`, which places yours.
  **Users who keep their own `pill.segments` with only specific
  `extensionStatus:<key>` entries will not see a new status until they add it.**
  Say so in your README.
- The status is not switched off for that key in `/starline`'s *Extension
  segments* tab, or placed on the editor row.

`ctx.ui.setStatus(key, undefined)` removes the pill; do that when there is nothing
to show, so the bar stays short.

## 1. Your own extension

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PillApi } from "pi-starline/types/pill-api";

const pillApi = () =>
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-starline.pill-api.v1")] as
		| PillApi
		| undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("my-plugin", "3 tasks");

		pillApi()?.register("my-plugin", ({ ctx, pill }) => {
			pillApi()?.showBubble(
				ctx,
				{
					title: "My plugin",
					body: [
						"build · 12s",
						"lint · done",
						{ text: "▸ stop the build", onSelect: () => stopBuild() },
					],
					hint: "esc to close",
				},
				pill,
			);
		});
	});
}
```

- **Register in `session_start`.** It runs after every extension has loaded, so
  the API is there whatever the load order, and it runs again after `/reload`.
  Registering the same key again replaces the earlier action.
- **The key is your status key.** That is how Starline knows which pill is yours.
  Starline's own segment names (`queue`, `model`, …) win over a status with the
  same key.
- **Pass `pill` through.** It is where the footer drew your pill; without it the
  bubble opens centred above the footer instead of on your pill.
- The types are optional: `pi-starline` as a dev dependency gives you
  `pi-starline/types/pill-api`, and at runtime nothing is imported.

## 2. Someone else's extension: a bridge

If the extension you want in a pill does not publish a status, or does not use
the pill API, a bridge can do both on its behalf. Put it in its own file, for
example `~/.pi/agent/extensions/foo-bridge.ts`, and Pi loads it like any other
extension.

What the bridge can show depends on what the other extension makes public:

| It publishes | Bridge quality |
| --- | --- |
| Events or an RPC on `pi.events` | Good: exact data, updated when it changes |
| Files (state, logs, artifacts) | Workable: read on open, may break when it updates |
| Nothing but its own UI | Not possible; ask its author for an event |

Prefer documented interfaces. Reading another extension's private state works
until its next release.

A bridge for an extension that announces its jobs on `pi.events` (the event names
here are made up; use what the extension documents):

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PillApi } from "pi-starline/types/pill-api";

type Job = { name: string; startedAt: number };

const pillApi = () =>
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-starline.pill-api.v1")] as
		| PillApi
		| undefined;

export default function (pi: ExtensionAPI) {
	let jobs: Job[] = [];
	let current: ExtensionContext | undefined;

	const publish = () => {
		current?.ui.setStatus("foo-jobs", jobs.length > 0 ? `${jobs.length} jobs` : undefined);
	};

	pi.events.on("foo:jobs-changed", (data) => {
		jobs = Array.isArray((data as { jobs?: unknown }).jobs) ? (data as { jobs: Job[] }).jobs : [];
		publish();
	});

	pi.on("session_start", (_event, ctx) => {
		current = ctx;
		publish();
		pillApi()?.register("foo-jobs", ({ ctx, pill }) => {
			const handle = pillApi()?.showBubble(
				ctx,
				() => ({
					title: `${jobs.length} jobs`,
					body: jobs.map((job) => `· ${job.name} · ${Math.round((Date.now() - job.startedAt) / 1000)}s`),
					hint: "esc to close",
				}),
				pill,
			);
			// Live while open: tick the elapsed times, stop when it closes.
			const timer = setInterval(() => handle?.refresh(), 1000);
			handle?.onClose(() => clearInterval(timer));
			if (!handle) clearInterval(timer); // Starline before 0.4: no live bubbles
		});
	});

	pi.on("session_shutdown", () => {
		current = undefined;
	});
}
```

Starline's own `subagents` pill is this pattern built in: it reads
[pi-subagents](https://github.com/nicobailon/pi-subagents)' public RPC on
`pi.events`. See [clickable-pills.md](clickable-pills.md#the-subagents-pill).

## Live content

Pass a function instead of an object and `showBubble` calls it again on every
`refresh()` of the handle it returns:

```ts
const handle = api.showBubble(ctx, () => contentFrom(latestState), pill);
handle?.refresh(); // whenever your data changed
```

- **Drive it yourself.** Starline does not poll your function; call `refresh()`
  from your own events or a timer, and stop the timer in `onClose`.
- **`onClose` runs once, however the bubble ends**: Escape, a second click on the
  pill, another pill's bubble replacing it, the session ending, or `close()`. If
  the bubble is already closed it runs at once.
- **Width.** A bubble is sized to its widest line (24–64 columns) when it opens.
  If a refresh makes a line wider it reopens wider in the same place; it never
  narrows while open. Keep lines of steady length if you can.
- `refresh()` after the bubble closed does nothing, so a late timer is harmless.
- A content function that throws keeps the last content on screen.

`showBubble` returns the handle from Starline 0.4 on. Earlier versions return
nothing and only take an object; `handle?.` covers both.

## Keyboard and `via`

Every registered key also runs as `/starline <key>`, with the anchor of the pill
the footer last drew. The context says which way the action was reached:

```ts
api.register("my-plugin", ({ ctx, pill, via }) => {
	if (via === "command") return runTheDefaultThing(ctx); // no pointer to pick with
	api.showBubble(ctx, pickerContent(), pill);
});
```

A bubble's targets need a pointer. If your bubble is mostly choices, give the
command a direct behaviour, the way `/starline thinking` steps to the next level
while a click opens the list. `via` is absent on Starline versions before it was
added; treat that as a click.

## Rules of thumb

- One bubble is open at a time. Opening yours closes any other.
- `onSelect` runs after the bubble has closed. To show a follow-up view, open a
  new bubble from it.
- Keep it short. A bubble is a glance, not a panel: a title, a handful of lines,
  a hint. Truncate long text yourself; lines wrap at the bubble's width.
- Everything is plain text. ANSI styling in your strings is kept, but the bubble
  paints its own background and text colour from your pill.

## Reference

`types/pill-api.d.ts` in the package is the source of truth; summary:

| Member | Shape |
| --- | --- |
| `Symbol.for("pi-starline.pill-api.v1")` | the `PillApi` object on `globalThis` |
| `api.version` | `1` |
| `api.register(key, action)` | returns an unregister function |
| `action({ ctx, pill?, via? })` | `via` is `"click"` or `"command"` |
| `api.showBubble(ctx, content, pill?)` | `content` is `PillBubbleContent` or a function returning one; returns `PillBubbleHandle` (0.4+) |
| `PillBubbleContent` | `{ title?, body: Array<string \| { text, onSelect, current? }>, hint? }` |
| `PillBubbleHandle` | `refresh()`, `close()`, `isOpen()`, `onClose(callback)` |
