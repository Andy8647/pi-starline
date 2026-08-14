/**
 * Expanding one tool box by clicking it.
 *
 * `ctrl+o` toggles every box in the transcript at once, which is a screenful
 * for the one line of output you wanted. This resolves the component under a
 * mouse press and, when the press landed on that component's *hint row*,
 * toggles just it.
 *
 * ## Why the hint row is the only target
 *
 * The plan for this feature started as "click the box's border". Pi 0.84's own
 * tool boxes have no border: there is not a single box-drawing character
 * anywhere in `pi-coding-agent`'s tool rendering, and a collapsed box is a
 * plain `Container` of preview lines with an inline hint. The `╭─╮ │ ╰─╯` in a
 * real session comes from `pi-toolbox`, a separate extension that patches
 * `ToolExecutionComponent.prototype.render`. So a border is conditional on
 * what else is installed and cannot be the target — and inferring one from the
 * rendered rows is exactly what frame-free selection was cut for.
 *
 * The hint row can be. Pi renders it through `keyHint("app.tools.expand",
 * description)` (`keybinding-hints.js`), which is `theme.fg("dim", keyText) +
 * theme.fg("muted", " " + description)`, and every call site wraps it in
 * parentheses:
 *
 * - `bash-execution.js:140,143` — `(ctrl+o to collapse)` when expanded,
 *   `... 3 more lines (ctrl+o to expand)` when collapsed.
 * - `core/tools/{bash,find,grep,ls,read,write}.js` — `... (N more lines,
 *   ctrl+o to expand)`.
 * - `read.js:91`, `skill-invocation-message.js:42`,
 *   `branch-summary-message.js:39`, `compaction-summary-message.js:40` —
 *   `(ctrl+o to expand)` on the title line.
 *
 * The description carries the *direction*: `to expand` when collapsed, `to
 * collapse` when expanded. That is what this module toggles on, rather than
 * tracking expansion itself — a `WeakMap` of "what I last set" would desync
 * the first time `ctrl+o` toggled everything behind its back, whereas the row
 * on screen is by definition current.
 *
 * ## Why resolution goes through the component tree
 *
 * `layoutComponent` builds a child box only for a component carrying a
 * `LAYOUT_NODE`, and only `Stack` and `ScrollView` have one. Every message
 * component extends `Container`, which has none, so the whole transcript is a
 * single leaf box and `boxesAt` can never return a tool box. The layout tree
 * is used for exactly what it does know — which scroll view is under the
 * pointer, and where content row 0 sits on screen — and ownership below that
 * comes from `component-tree.ts`. `test/contract/transcript-layout.test.ts`
 * pins both halves against pi-tui's real engine.
 *
 * ## What this deliberately does not do
 *
 * Nothing here looks at how a component *renders* to decide what it is:
 * `isExpandableComponent` asks whether `setExpanded` is callable, and the hint
 * rule is scoped to that component's own rows. An ordinary message that quotes
 * the hint — an assistant explaining `ctrl+o`, a paste of these very docs — is
 * a `Text` or a `Markdown` with no `setExpanded` anywhere in its path, so it
 * resolves to nothing and the press starts a selection as usual.
 *
 * ## Two accepted limitations
 *
 * Both are known, both were weighed, and neither has a fix worth its cost.
 * They are recorded here and in `docs/configuration.md` because a user meets
 * them before they meet any of the reasoning above.
 *
 * **1. Clicking cannot always collapse what it expanded.** The premise that
 * "the hint row exists in both states, so one rule covers both directions" is
 * only true of `bash-execution` and of `tool-execution` results that still
 * have a preview to hide. For everything else Pi renders the hint *only while
 * collapsed*, so expanding it removes the very row that would close it again:
 *
 * - `core/tools/{read,grep,ls,write,find}.js` append the hint inside `if
 *   (remaining > 0)`, and expanding sets `maxLines` to `lines.length`, so
 *   `remaining` becomes 0 and the row is not emitted at all (`read.js:113-118`
 *   is the clearest instance).
 * - `skill-invocation-message.js:42`, `branch-summary-message.js:39` and
 *   `compaction-summary-message.js:40` build the hint in their `else` branch,
 *   i.e. only when `this.expanded` is false.
 *
 * For the first group there is a way back: current `pi-toolbox` appends a
 * `(ctrl+o to collapse)` anchor row as the last line inside the frame of an
 * expanded `ToolExecutionComponent` — the same text `bash-execution` renders
 * natively — and the hint rule above matches it exactly as it matches Pi's
 * own rows, because it is the component's own rendered row. That closes
 * `read`/`grep`/`ls`/`write`/`find` boxes with one click. The second group
 * (skill, branch and compaction summaries) keeps the limitation: no anchor
 * exists for them, `ctrl+o` (which closes everything) is the way back, and
 * inventing a second target (the title line, the first output row) would
 * mean guessing at a component's layout, which is the inference this module
 * exists to avoid. Without `pi-toolbox` installed the first group keeps the
 * limitation too — no anchor is rendered, and nothing here invents one.
 *
 * **2. A box's own output can read like its hint.** The component scoping
 * above stops a *different* message from being clickable, but not the box's
 * own body: a line inside an expandable component that literally contains
 * `(ctrl+o to expand)` — `cat` of a file documenting the keybinding, a
 * transcript of this very docstring — is indistinguishable from the real hint,
 * because Pi renders the box's output and the box's hint through the same
 * `Text` with the same structure and only different theme colours. Matching
 * the colours instead would make the rule depend on the user's theme.
 * Accepted: the worst case is that a click on a box opens the box it is
 * already inside — no crash, no lost input, and the same click a row above or
 * below behaves normally.
 */

import { keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createComponentTree, isComponentLike, isExpandableComponent } from "./component-tree";
import { type BoxLike, boxesAt, scrollContentLinesFor, scrollContentOrigin } from "./hit-test";

/** The slice of a Pi message component this module calls. */
export type ExpandableComponent = { setExpanded(expanded: boolean): void };

export type ExpandTarget = {
	component: ExpandableComponent;
	/** What `setExpanded` should be called with — the opposite of today. */
	expanded: boolean;
};

export type ExpandLookup = {
	/** `currentLayout.root`, or undefined before the first frame. */
	root: BoxLike | undefined;
	/** `keyText("app.tools.expand")` for this session; "" when unbound. */
	keyText: string;
};

const KEYBINDING = "app.tools.expand";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One press asks one question, but the pattern is the same on every press of a
// session, so it is built once per distinct key text rather than per call.
let cachedKeyText: string | undefined;
let cachedPattern: RegExp | undefined;

function hintPattern(keyText: string): RegExp {
	if (cachedPattern && cachedKeyText === keyText) return cachedPattern;
	// `\([^()]*` is the parenthesis Pi always opens before the hint, with
	// whatever prefix the call site put inside it ("... 12 more lines, ").
	// Case-insensitive: pi-mcp-adapter renders its collapsed-result hint as
	// `(Ctrl+O to expand)` — capitalized, unlike the `ctrl+o` Pi's own
	// `keyText` yields — and a case-sensitive match declined the press, so MCP
	// tool boxes were the one box a click could not open. Widening the match
	// only reaches rows an expandable component renders about its own key, so
	// the cost is the same accepted false positive as limitation 2 above.
	cachedPattern = new RegExp(`\\([^()]*${escapeRegExp(keyText)} to (expand|collapse)\\)`, "i");
	cachedKeyText = keyText;
	return cachedPattern;
}

/**
 * Whether `line` is Pi's expand hint, and which way clicking it goes.
 *
 * The line arrives with theme colours in it, so it is stripped the same way
 * Pi's own `getWordSelection` strips a selection source line. An empty
 * `keyText` declines everything: with no key bound the pattern would collapse
 * to `(… to expand)` and start matching ordinary prose.
 */
export function expandHintAction(line: string, keyText: string): "expand" | "collapse" | undefined {
	if (!keyText) return undefined;
	const match = hintPattern(keyText).exec(stripTerminalSequences(line));
	if (!match) return undefined;
	return match[1] === "collapse" ? "collapse" : "expand";
}

/**
 * The keys spelled the way the hint on screen spells them.
 *
 * The primary source is `pi-coding-agent`'s own exported `keyText` — literally
 * the function `keyHint` calls to build the text this module then matches, so
 * there is no second formatting rule to drift (it is `keyText` that turns
 * `alt` into `option` on macOS and joins alternatives with "/"), and no second
 * keybinding registry to disagree.
 *
 * That last point is not theoretical. `getKeybindings()` is a *singleton* per
 * copy of pi-tui, and a copy is per `node_modules` tree: in this repo
 * `pi-coding-agent` nests its own pi-tui, so the registry Starline's direct
 * import reaches is not the registry the hints are rendered from. Production
 * resolves both to Pi's own copy, but reading the value through the same
 * package that renders it makes the question moot instead of assumed.
 *
 * pi-tui's registry is kept as a fallback for the case where `keyText` yields
 * nothing — which also means nothing is on screen to match, so the fallback
 * can only ever turn a non-match into a non-match. Both routes return "" when
 * `app.tools.expand` is unbound, and `expandHintAction` reads "" as "no hint
 * rule at all" rather than as a wildcard.
 */
export function expandKeyText(): string {
	return keyTextFor(KEYBINDING);
}

/**
 * `keyText(keybinding)` with the registry fallback, shared by every feature
 * that quotes a key on screen. See `expandKeyText` for why the primary route
 * is pi-coding-agent's own function rather than this repo's registry.
 */
export function keyTextFor(keybinding: string): string {
	try {
		const rendered = keyText(keybinding as never);
		if (typeof rendered === "string" && rendered.length > 0) return rendered;
	} catch {
		// A Pi build that has moved this function is one where quoting the key
		// simply shows nothing; it is never a reason to break a mouse feature.
	}
	return fallbackKeyText(keybinding);
}

/**
 * `keyText` re-derived from pi-tui's registry: keys joined with "/", `alt`
 * shown as `option` on macOS, matching `formatKeyText` in
 * `keybinding-hints.js`.
 */
function fallbackKeyText(keybinding: string): string {
	try {
		const bound: unknown = getKeybindings().getKeys(keybinding as never);
		if (!Array.isArray(bound) || bound.length === 0) return "";
		const keys = bound.filter((key): key is string => typeof key === "string");
		return keys
			.map((key: string) =>
				key
					.split("+")
					.map((part) =>
						process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part,
					)
					.join("+"),
			)
			.join("/");
	} catch {
		return "";
	}
}

/** The innermost scroll view whose box contains the screen cell. */
function scrollViewAt(root: BoxLike, x: number, y: number): unknown {
	let found: unknown;
	for (const box of boxesAt(root, x, y)) {
		const scrollView = (box as { scrollView?: unknown }).scrollView;
		if (scrollView !== undefined) found = scrollView;
	}
	return found;
}

/**
 * The expandable component whose hint row is at screen cell (`x`, `y`), or
 * undefined when that cell is anything else.
 *
 * Resolution is done end to end here and thrown away: the component tree it
 * builds holds no invalidation and a running tool re-renders under it (a
 * `BashExecutionComponent` carries a ticking `Loader`), so the answer is only
 * true of the frame that is on screen at this instant. Callers act on it
 * inside the same press or not at all.
 */
export function expandTargetAt(
	lookup: ExpandLookup,
	x: number,
	y: number,
): ExpandTarget | undefined {
	// Renamed on the way out of `lookup` so it cannot be read as this module's
	// imported `keyText` function.
	const { root, keyText: keys } = lookup;
	if (!root || !keys) return undefined;

	const scrollView = scrollViewAt(root, x, y);
	if (scrollView === undefined) return undefined;
	const lines = scrollContentLinesFor(root, scrollView);
	const origin = scrollContentOrigin(root, scrollView);
	if (!lines || !origin) return undefined;
	if (!isComponentLike(origin.component)) return undefined;

	// The content box is laid out at `viewportY - scrollTop`, so a screen row
	// becomes a content row by subtracting its origin — the relation pinned in
	// `test/contract/transcript-layout.test.ts`.
	const row = y - origin.rect.y;
	if (row < 0 || row >= lines.length) return undefined;

	const tree = createComponentTree(origin.component, origin.rect.width, lines);
	const path = tree.pathAt(row);
	for (let index = path.length - 1; index >= 0; index--) {
		const span = path[index];
		if (!isExpandableComponent(span.component)) continue;
		// The hint is matched against this component's own rendered row, not
		// against the transcript, so nothing outside the box it would toggle can
		// stand in for its hint.
		const action = expandHintAction(span.lines[row - span.start] ?? "", keys);
		if (!action) return undefined;
		return { component: span.component as ExpandableComponent, expanded: action === "expand" };
	}
	return undefined;
}
