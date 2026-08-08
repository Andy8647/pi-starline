/**
 * The shape Pi's layout engine really produces for a transcript, asserted
 * against the installed `@earendil-works/pi-tui` rather than a fixture.
 *
 * This file exists because a fixture said otherwise for three review rounds.
 * Frame-free selection was built on the assumption that a tool box has its own
 * `LayoutBox` nested under the transcript's, and every hand-written fixture
 * agreed, and none of it did anything in a real session — because
 * `layoutComponent` only builds a child box for a component carrying
 * `LAYOUT_NODE`, and only `Stack` and `ScrollView` have one. The transcript is
 * one leaf box with `children: []`.
 *
 * So the facts underneath `component-tree.ts` are pinned here, in the real
 * engine: the leaf box's `component` is the transcript container, its
 * `rect.width` is the width that container was rendered at, and its rows are
 * that container's own `render` output. If any of those stops being true, this
 * goes red instead of the feature going quietly inert again.
 */

import { ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, it } from "vitest";
import { frameRowsIn, scrollContentOrigin } from "../../extensions/starline/mouse/frame-detection";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import { copyableLines } from "../../extensions/starline/mouse/selection-copy";
import { makeTranscript, rowRangeOf } from "../mouse/component-graph";

const WIDTH = 40;
const HEIGHT = 8;

function renderTranscript() {
	const transcript = makeTranscript(WIDTH);
	const scroll = new ScrollView(transcript.document);
	const root = new VStack([{ component: scroll, grow: 1 }, { component: new Text("dock", 0, 0) }]);
	const frame = renderLayoutFrame(root, WIDTH, HEIGHT, () => {});
	const scrollBox = frame.root.children[0] as BoxLike & {
		scrollView?: unknown;
		scrollContentLines?: readonly string[];
	};
	return { transcript, scroll, frame, scrollBox };
}

describe("Pi's transcript layout", () => {
	it("gives the whole transcript one leaf box, with no box per message", () => {
		const { transcript, scrollBox } = renderTranscript();
		const contentBox = scrollBox.children?.[0];

		expect(contentBox?.component).toBe(transcript.document);
		// The finding this task was built on. A box here would mean the layout
		// tree could answer ownership; there is never one.
		expect(contentBox?.children).toEqual([]);
	});

	it("renders the transcript container at the content box's own width", () => {
		const { transcript, scrollBox } = renderTranscript();
		const contentBox = scrollBox.children?.[0];
		const lines = scrollBox.scrollContentLines;

		expect(contentBox?.rect.width).toBe(WIDTH);
		// `createComponentTree` is handed exactly this width and these lines.
		expect(lines).toEqual(transcript.document.render(contentBox?.rect.width ?? 0));
		expect(lines?.length).toBeGreaterThan(HEIGHT); // it really does overflow
	});

	it("copies a real selection frame-free, with the table intact", () => {
		const { transcript, frame, scroll, scrollBox } = renderTranscript();
		const origin = scrollContentOrigin(frame.root as BoxLike, scrollBox.scrollView);
		const lines = scrollBox.scrollContentLines ?? [];
		const start = rowRangeOf(lines, transcript.tool, WIDTH).start;
		const end = lines.length - 1;

		const owned = frameRowsIn(start, end, lines, origin as BoxLike);
		const copied = copyableLines(
			lines.slice(start, end + 1).map((line) => line.trimEnd()),
			owned,
		);

		expect(copied).toEqual([
			"",
			"hello from the tool",
			" ┌───┬───┐",
			" │ a │ b │",
			" ├───┼───┤",
			" │ c │ d │",
			" └───┴───┘",
		]);
		expect(scroll.scrollTop).toBe(0);
	});

	it("gives the same answer after the transcript has scrolled away", () => {
		// The ordinary copyOnSelect:false flow: select, then scroll (Pi does it
		// on its own while a response streams), then press ctrl+c. The layout
		// tree's `clip` changes underneath; content rows do not.
		const { transcript, frame, scroll, scrollBox } = renderTranscript();
		const lines = scrollBox.scrollContentLines ?? [];
		const start = rowRangeOf(lines, transcript.tool, WIDTH).start;
		const before = frameRowsIn(
			start,
			lines.length - 1,
			lines,
			scrollContentOrigin(frame.root as BoxLike, scrollBox.scrollView) as BoxLike,
		);

		scroll.scrollToEnd();
		const scrolled = renderLayoutFrame(
			new VStack([{ component: scroll, grow: 1 }, { component: new Text("dock", 0, 0) }]),
			WIDTH,
			HEIGHT,
			() => {},
		);
		const scrolledScrollBox = scrolled.root.children[0] as BoxLike & { scrollView?: unknown };
		const scrolledOrigin = scrollContentOrigin(
			scrolled.root as BoxLike,
			scrolledScrollBox.scrollView,
		) as BoxLike;

		expect(scroll.scrollTop).toBeGreaterThan(0);
		// The rows really are off-screen now: the content box sits above the
		// viewport and its clip has been cut back to what is still painted.
		expect(scrolledOrigin.rect.y).toBe(-scroll.scrollTop);
		expect([...frameRowsIn(start, lines.length - 1, lines, scrolledOrigin)]).toEqual([...before]);
	});
});
