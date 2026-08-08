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
