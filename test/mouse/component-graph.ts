/**
 * A transcript built out of Pi's own components, for tests that need the row
 * ranges to be real.
 *
 * Every layout fixture this feature was built on described a shape production
 * never produces: a `LayoutBox` per message component, nested under the
 * transcript's box. There is no such box — pi-tui only builds one for a
 * component carrying `LAYOUT_NODE`, and no message component has one — which
 * is why three rounds of green fixtures sat on top of a feature that did
 * nothing. Hand-written rects cannot drift back into agreement with reality;
 * a real graph can only be wrong in ways the real thing is also wrong in.
 *
 * So the pieces here are the real ones wherever they can be:
 *
 * - `Container`, `Text` and `Markdown` are pi-tui's, imported from the
 *   installed package. If `Container.render` ever stops being a plain
 *   concatenation, or `Markdown` stops drawing tables out of box-drawing
 *   glyphs, these fixtures go red — which is the point.
 * - `FramedToolComponent` is the one thing that has to be a stand-in, because
 *   `pi-coding-agent` is not a dependency of this package. It is
 *   `pi-toolbox`'s patched `ToolExecutionComponent.render` transcribed: a
 *   `Container` subclass exposing `setExpanded`, whose render opens with a
 *   blank spacer row and then wraps its children's lines in `drawFrame`.
 *   That leading `""` is not decoration — it is `const out: string[] = [""]`
 *   in `pi-toolbox/frame.ts`, and it is why a frame's first *rendered* row is
 *   never the top rule.
 */

import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	Text,
} from "@earendil-works/pi-tui";
import { drawToolboxFrame } from "./toolbox-frame";

/**
 * A `MarkdownTheme` that styles nothing, so a rendered table is exactly the
 * glyphs pi-tui chose with no ANSI in the way. `Markdown` requires a theme;
 * `renderTable` calls `theme.bold` on every header cell and throws without one.
 */
export const plainMarkdownTheme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};

/**
 * `pi-toolbox`'s framed tool box: a `Container` subclass with `setExpanded`,
 * rendering a blank row and then its children inside a rounded frame. The
 * children are rendered two cells narrower, leaving room for the verticals,
 * exactly as `frame.ts` does (`source.render(w - 2)`).
 *
 * The override matters as much as the frame: it is what makes this
 * component's `children` stop being a partition of its own rows, and so what
 * the component-tree walk's verification step has to notice and stop at.
 */
export class FramedToolComponent extends Container {
	expanded = false;

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	override render(width: number): string[] {
		const content = super.render(width - 2);
		if (content.length === 0) return [];
		return ["", ...drawToolboxFrame(content, width)];
	}
}

/** A leaf that renders fixed lines — for asserting on exact row ranges. */
export class FixedLines implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/**
 * A tool box the way `pi-toolbox` renders it after the collapse-anchor
 * change: the frame from `FramedToolComponent`, and — when expanded — a
 * `(ctrl+o to collapse)` row appended as the last line *inside* the frame,
 * where `frame.ts` pushes it after `trimBlankEdges`. Pi itself only renders
 * an expand hint while collapsed for the types `ToolExecutionComponent`
 * covers, so this row is the only thing a click can close the box through.
 *
 * Collapsed, the preview and the `to expand` hint are the component's
 * children (Pi's own rendering); the anchor is not — it is added at render
 * time, exactly as `pi-toolbox` does, so the component-tree walk meets it as
 * a row the framed component itself drew.
 */
export class AnchoredFramedToolComponent extends Container {
	expanded = false;

	constructor(
		private readonly title: string,
		private readonly output: readonly string[],
		private readonly previewLines = 1,
		private readonly keyText = EXPAND_KEY_TEXT,
	) {
		super();
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(this.title, 0, 0));
		const shown = this.expanded ? this.output : this.output.slice(0, this.previewLines);
		for (const line of shown) this.addChild(new Text(line, 0, 0));
		if (!this.expanded) {
			this.addChild(
				new Text(expandHintLine(this.keyText, false, this.output.length - this.previewLines), 0, 0),
			);
		}
	}

	override render(width: number): string[] {
		const content = super.render(width - 2);
		if (content.length === 0) return [];
		if (this.expanded) content.push(expandHintLine(this.keyText, true));
		return ["", ...drawToolboxFrame(content, width)];
	}
}

/**
 * An expandable component that draws no frame — what Pi's own message
 * components are without `pi-toolbox` patching them (`tool-execution.js`'s
 * default path is `super.render(width)`, a background fill and no border
 * glyphs). `setExpanded` alone must not make a component's rows frame rows.
 */
export class ExpandableText implements Component {
	expanded = false;
	constructor(private readonly lines: readonly string[]) {}
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/**
 * `keyText("app.tools.expand")` as a default Pi prints it. Fixtures spell it
 * out rather than reading the global keybinding registry, because a test that
 * shares that global with every other test file is a test that depends on run
 * order — the one place the real registry is read is
 * `tool-box.test.ts`'s `expandKeyText` case, which sets and restores it.
 */
export const EXPAND_KEY_TEXT = "ctrl+o";

const DIM_START = "\x1b[2m";
const DIM_END = "\x1b[22m";

/**
 * The hint row Pi renders, ANSI and all.
 *
 * `keyHint("app.tools.expand", description)` is `theme.fg("dim", keyText) +
 * theme.fg("muted", " " + description)` (`keybinding-hints.js`), and every
 * caller wraps it in parentheses. The two shapes here are
 * `bash-execution.js:140,143` verbatim — the one component that renders a hint
 * in *both* states, which is what makes one rule cover both directions.
 */
export function expandHintLine(
	keyText: string,
	expanded: boolean,
	hiddenLineCount = 3,
	color: (text: string) => string = (text) => `${DIM_START}${text}${DIM_END}`,
): string {
	return expanded
		? `${color("(")}${color(keyText)}${color(" to collapse")}${color(")")}`
		: `${color(`... ${hiddenLineCount} more lines (`)}${color(keyText)}${color(" to expand")}${color(")")}`;
}

/**
 * Pi's own expandable box, borderless — `BashExecutionComponent` in miniature.
 * A `Container` subclass whose `setExpanded` rebuilds its children (that is
 * what `bash-execution.js:48` and `tool-execution.js:161` both do, via
 * `updateDisplay`), showing a preview plus a `to expand` hint when collapsed
 * and the whole output plus a `to collapse` hint when expanded.
 *
 * It draws no box-drawing characters, because Pi's own boxes do not: the
 * borders in a real session come from `pi-toolbox` patching
 * `ToolExecutionComponent.prototype.render` (see `FramedToolComponent`).
 */
export class HintedToolComponent extends Container {
	expanded = false;

	constructor(
		private readonly title: string,
		private readonly output: readonly string[],
		private readonly previewLines = 1,
		private readonly keyText = EXPAND_KEY_TEXT,
	) {
		super();
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(this.title, 0, 0));
		const shown = this.expanded ? this.output : this.output.slice(0, this.previewLines);
		for (const line of shown) this.addChild(new Text(line, 0, 0));
		this.addChild(
			new Text(
				expandHintLine(this.keyText, this.expanded, this.output.length - this.previewLines),
				0,
				0,
			),
		);
	}
}

/** A leaf whose render throws, for the "one bad component" case. */
export class ThrowingComponent implements Component {
	invalidate(): void {}
	render(): string[] {
		throw new Error("render exploded");
	}
}

export type Transcript = {
	/** The transcript `Container`, i.e. what the scroll content box wraps. */
	document: Container;
	/** The `Container` messages are appended to, one level down. */
	chat: Container;
	tool: FramedToolComponent;
	table: Markdown;
	width: number;
	/** `document.render(width)` — the rows a selection is extracted from. */
	lines: string[];
};

const TABLE_MARKDOWN = "| a | b |\n| --- | --- |\n| c | d |\n";

/**
 * The shape `interactive-mode.js` builds: `documentContainer` holding
 * `chatContainer`, with messages appended to the latter (lines 346-352 and
 * every `this.chatContainer.addChild(...)`). Two nested plain containers, so
 * the walk has to recurse rather than find everything at depth one.
 *
 * The contents are the case that started this task: some ordinary text, a
 * framed expandable tool box, and a markdown table right underneath it, so
 * one selection can cross both.
 */
export function makeTranscript(width = 40): Transcript {
	const document = new Container();
	const chat = new Container();
	document.addChild(chat);

	chat.addChild(new Text("first message", 0, 0));
	const tool = new FramedToolComponent();
	tool.addChild(new Text("hello from the tool", 0, 0));
	chat.addChild(tool);
	const table = new Markdown(TABLE_MARKDOWN, 1, 0, plainMarkdownTheme);
	chat.addChild(table);

	return { document, chat, tool, table, width, lines: document.render(width) };
}

/**
 * The row a component's rendered output starts at inside `lines`, found by
 * searching for it rather than by counting — so a fixture's expectations
 * cannot quietly disagree with the render they were derived from.
 */
export function rowRangeOf(
	lines: readonly string[],
	component: { render(width: number): string[] },
	width: number,
): { start: number; end: number } {
	const own = component.render(width);
	for (let start = 0; start + own.length <= lines.length; start++) {
		if (own.every((line, offset) => lines[start + offset] === line)) {
			return { start, end: start + own.length };
		}
	}
	throw new Error("component's rendered lines do not appear in the transcript");
}
