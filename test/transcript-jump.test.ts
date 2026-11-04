import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	forgetTranscriptJump,
	installTranscriptJump,
	jumpToLatestMessage,
	jumpToPreviousPrompt,
	previousPromptRow,
	promptRows,
} from "../extensions/starline/transcript-jump";

/**
 * Only `render` and `children` are read, so a stub stands in for every component
 * but the prompt itself. `box(rows)` claims that many lines at any width.
 */
function box(rows: number) {
	return { render: () => Array.from({ length: rows }, () => "x") };
}

function container(children: unknown[]) {
	return { children, render: () => [] };
}

/** The slice of `ScrollView` the module reads, plus the two calls a test can watch. */
type FakeView = {
	children: unknown[];
	scrollTop: number;
	scrollTo: (scrollTop: number) => void;
	scrollToEnd?: () => void;
	getContentWidth: (width: number) => number;
};

function view(document: unknown, scrollTop = 0): FakeView {
	return {
		children: [document],
		scrollTop,
		scrollTo: () => {},
		getContentWidth: (width: number) => width,
	};
}

/**
 * Real prompts: `promptRows` matches the class Pi builds them from, not a shape.
 *
 * `render` is replaced on the instance because the real one paints Markdown, and
 * that wants an initialized theme. `instanceof` is what the walk reads, so the
 * stub keeps the class and only fixes the height.
 */
function prompt(rows = 2) {
	const component = new UserMessageComponent("hi");
	component.render = () => Array.from({ length: rows }, () => "x");
	return component;
}

describe("previousPromptRow", () => {
	it("takes the last prompt strictly above the viewport top", () => {
		expect(previousPromptRow([0, 40, 90], 95)).toBe(90);
	});

	it("skips a prompt that is still on screen, so the next press moves on", () => {
		expect(previousPromptRow([0, 40, 90], 90)).toBe(40);
	});

	it("offers nothing when every prompt is at or below the top", () => {
		expect(previousPromptRow([10, 40], 10)).toBeUndefined();
		expect(previousPromptRow([], 10)).toBeUndefined();
	});

	it("reaches the first prompt of the transcript", () => {
		expect(previousPromptRow([7, 40], 8)).toBe(7);
	});
});

describe("installTranscriptJump", () => {
	const prototype = TuiAltScreen.prototype as unknown as {
		compositeScrollToEndIndicator: (screen: string[], layout: unknown, width: number) => string[];
	};
	let dispose: () => void = () => {};

	afterEach(() => {
		dispose();
		forgetTranscriptJump();
	});

	/** Call the patched method the way Pi's render loop does, on a fake instance. */
	function render(
		scrollView: FakeView,
		receiver: Record<string, unknown> = {},
		screen: string[] = ["row 0", "row 1"],
	): { screen: string[]; receiver: Record<string, unknown> } {
		const host = { requestRender: () => {}, ...receiver };
		const lines = prototype.compositeScrollToEndIndicator.call(
			host,
			screen,
			{ primaryScrollView: scrollView },
			80,
		);
		return { screen: lines, receiver: host };
	}

	it("leaves the frame alone and drops Pi's click target", () => {
		dispose = installTranscriptJump();
		const stale = { row: 23, column: 10, width: 26 };
		const { screen, receiver } = render(view(container([])), { scrollToEndIndicatorRect: stale });

		expect(screen).toEqual(["row 0", "row 1"]);
		expect(receiver.scrollToEndIndicatorRect).toBeUndefined();
	});

	it("jumps to the prompt above the viewport top", () => {
		dispose = installTranscriptJump();
		const scrolled: number[] = [];
		let painted = 0;
		const document = container([box(3), container([prompt(2), box(3), prompt(2)])]);
		const fake = view(document, 12);
		fake.scrollTo = (top: number) => {
			scrolled.push(top);
		};
		render(fake, { requestRender: () => painted++ });

		jumpToPreviousPrompt();

		// Header (3) + first prompt + spacer (3) = the second prompt's first row.
		expect(scrolled).toEqual([8]);
		expect(painted).toBe(1);
	});

	it("does nothing when no prompt starts above the top", () => {
		dispose = installTranscriptJump();
		const scrolled: number[] = [];
		const fake = view(container([container([prompt(2)])]), 0);
		fake.scrollTo = (top: number) => {
			scrolled.push(top);
		};
		render(fake);

		jumpToPreviousPrompt();

		expect(scrolled).toEqual([]);
	});

	it("returns to the end from anywhere", () => {
		dispose = installTranscriptJump();
		let ended = 0;
		const fake = { ...view(container([]), 40), scrollToEnd: () => ended++ };
		render(fake);

		jumpToLatestMessage();

		expect(ended).toBe(1);
	});

	it("goes inert once disposed", () => {
		dispose = installTranscriptJump();
		const scrolled: number[] = [];
		const document = container([container([prompt(2), box(4), prompt(2)])]);
		const fake = view(document, 6);
		fake.scrollTo = (top: number) => {
			scrolled.push(top);
		};
		render(fake);

		dispose();
		jumpToPreviousPrompt();

		expect(scrolled).toEqual([]);
	});
});

describe("promptRows", () => {
	it("counts the blocks above the chat, not just the chat", () => {
		const document = container([box(3), container([prompt(2), box(3), prompt(4)])]);
		expect(promptRows(view(document), 80)).toEqual([3, 8]);
	});

	it("ignores containers with no prompts in them", () => {
		const document = container([container([box(2), box(2)])]);
		expect(promptRows(view(document), 80)).toEqual([]);
	});

	it("returns nothing when the document is not a container yet", () => {
		expect(promptRows(view(undefined), 80)).toEqual([]);
		expect(promptRows(view(box(1)), 80)).toEqual([]);
	});

	it("survives a component that throws while being measured", () => {
		const broken = {
			render: () => {
				throw new Error("not ready");
			},
		};
		const document = container([container([prompt(2), broken, prompt(1)])]);
		// The broken block takes no rows, so the next prompt sits right after the first.
		expect(promptRows(view(document), 80)).toEqual([0, 2]);
	});
});
