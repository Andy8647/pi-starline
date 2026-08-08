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
 * That feature is gone (see `installMouse`), but the finding outlives it: any
 * question about an individual message — which one was clicked, which one owns
 * a row — has to be answered from the *component* tree, because the layout
 * tree has nothing below the transcript. So the facts underneath
 * `component-tree.ts` are pinned here, in the real engine: the leaf box's
 * `component` is the transcript container, its `rect.width` is the width that
 * container was rendered at, and its rows are that container's own `render`
 * output. If any of those stops being true, this goes red rather than the next
 * feature built on them going quietly inert.
 */

import { ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { describe, expect, it } from "vitest";
import { createComponentTree } from "../../extensions/starline/mouse/component-tree";
import { type BoxLike, scrollContentOrigin } from "../../extensions/starline/mouse/hit-test";
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

	it("resolves a content row to the message component that rendered it", () => {
		// What the layout tree cannot answer, and what `component-tree.ts` is
		// for: taking the leaf box's own component and width — the only two
		// things the box offers — back down to an individual message.
		const { transcript, frame, scrollBox } = renderTranscript();
		const origin = scrollContentOrigin(frame.root as BoxLike, scrollBox.scrollView) as BoxLike;
		const lines = scrollBox.scrollContentLines ?? [];
		const tree = createComponentTree(transcript.document, origin.rect.width, lines);
		const toolRows = rowRangeOf(lines, transcript.tool, WIDTH);
		const tableRows = rowRangeOf(lines, transcript.table, WIDTH);

		expect(origin.component).toBe(transcript.document);
		expect(tree.ownerAt(toolRows.start)?.component).toBe(transcript.tool);
		expect(tree.ownerAt(toolRows.end - 1)?.component).toBe(transcript.tool);
		expect(tree.ownerAt(tableRows.start)?.component).toBe(transcript.table);
		// The chain really is nested rather than flat: document > chat > message.
		expect(tree.pathAt(toolRows.start).map((span) => span.component)).toEqual([
			transcript.document,
			transcript.chat,
			transcript.tool,
		]);
	});

	it("gives the same answer after the transcript has scrolled away", () => {
		// Content rows are captured once (at mouse-down, at a click) and asked
		// about later, by which time Pi may have scrolled — it does so on its
		// own while a response streams. The layout tree's `clip` and the content
		// box's `rect.y` both move; which component rendered content row N does
		// not, because the component graph has no viewport in it.
		const { transcript, frame, scroll, scrollBox } = renderTranscript();
		const lines = scrollBox.scrollContentLines ?? [];
		const origin = scrollContentOrigin(frame.root as BoxLike, scrollBox.scrollView) as BoxLike;
		const row = rowRangeOf(lines, transcript.tool, WIDTH).start;
		const before = createComponentTree(transcript.document, origin.rect.width, lines).ownerAt(row);

		expect(origin.rect.y).toBe(0);
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
		// viewport by exactly scrollTop, which is the offset a screen row has to
		// be converted through to become a content row.
		expect(scrolledOrigin.rect.y).toBe(-scroll.scrollTop);
		expect(scrolledOrigin.rect.width).toBe(origin.rect.width);
		expect(
			createComponentTree(transcript.document, scrolledOrigin.rect.width, lines).ownerAt(row)
				?.component,
		).toBe(before?.component);
	});
});
