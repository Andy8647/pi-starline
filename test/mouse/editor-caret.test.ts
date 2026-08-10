/**
 * Clicking, selecting and copying inside the input box, against real geometry.
 *
 * Everything here is built from the real pieces: Starline's own
 * `PolishedEditor` (so the frame around the text is the one production draws),
 * mounted in pi-tui's `Container` inside the dock `VStack` that
 * `interactive-mode.js` builds, laid out by pi-tui's own `renderLayoutFrame`.
 * That matters more here than anywhere else in this feature, because the whole
 * task is an arithmetic claim about where the editor's text is on screen — and
 * a hand-written rect can be made to agree with any arithmetic at all.
 *
 * The numbers the assertions use are the ones that fixture produces:
 *
 *     row 12  ────────────────  box.rect.y, the top rule
 *     row 13  │                 editorPaddingY
 *     row 14  │ line 5          contentTop, showing absolute visual row 5
 *     ...
 *     row 20  │ line 11         the last of 7 visible rows
 *     row 21  │                 editorPaddingY
 *     row 22  │                 the metadata row
 *     row 23  ────────────────  the bottom rule
 *
 * `│ ` is the rail, which is why editor text starts at column 2 and a click on
 * the rail itself has to land on column 0 rather than on a negative one.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	KeybindingsManager,
	ScrollView,
	setKeybindings,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	TUI_KEYBINDINGS,
	VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../../extensions/starline/config";
import {
	activeEditorViewport,
	caretPositionAt,
	deleteEditorSelection,
	editorSelectionRange,
	editorSelectionText,
	editorViewport,
} from "../../extensions/starline/mouse/editor-caret";
import { editorBoxFor, setActiveEditor } from "../../extensions/starline/mouse/editor-mouse";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import {
	activeSelectionHintText,
	externalEditorHintText,
	installMouse,
} from "../../extensions/starline/mouse/index";
import { PolishedEditor } from "../../extensions/starline/ui";
import { HintedToolComponent } from "./component-graph";

const WIDTH = 40;
const HEIGHT = 24;
/** `editorVisibleLines(24)` — Pi's own `max(5, floor(rows * 0.3))`. */
const VISIBLE = 7;
const CONTENT_TOP = 14;
const TEXT_COLUMN = 2;

function makeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
		getThinkingBorderColor: () => (text: string) => text,
	} as unknown as Theme;
}

/** `defaultConfig` with the metadata row blanked, so the frame is only frame. */
function makeConfig(overrides: Partial<PolishedTuiConfig> = {}): PolishedTuiConfig {
	return { ...defaultConfig, editorMetadataFormat: "", ...overrides };
}

function makeEditor(config: PolishedTuiConfig): PolishedEditor {
	return new PolishedEditor(
		{ requestRender() {}, terminal: { rows: HEIGHT, cols: WIDTH } } as never,
		{ borderColor: (text: string) => text, selectList: {} } as never,
		{} as never,
		makeTheme(),
		() => config,
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
	);
}

/**
 * The dock shape `interactive-mode.js` builds, reduced to the editor slot —
 * the same arrangement `editor-wheel.test.ts` lays out, so both features are
 * measured against one geometry.
 */
function mount(editor: PolishedEditor) {
	const container = new Container();
	container.addChild(editor as never);
	const transcript = new ScrollView(new Text("filler\n".repeat(60), 0, 0), { primary: true });
	const dock = new VStack([{ component: container, shrink: 1, minSize: 3 }]);
	const root = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	const frame = renderLayoutFrame(root, WIDTH, HEIGHT, () => {}) as { root: BoxLike };
	const box = editorBoxFor(frame.root, editor);
	if (!box) throw new Error("the editor is not in the layout");
	return { container, frame, box };
}

function arrange(text: string, config = makeConfig()) {
	const editor = makeEditor(config);
	editor.setText(text);
	const mounted = mount(editor);
	const viewport = editorViewport(editor, mounted.box, {
		paddingY: config.editorPaddingY,
		textColumn: TEXT_COLUMN,
		terminalRows: HEIGHT,
	});
	if (!viewport) throw new Error("no viewport");
	return { editor, viewport, ...mounted };
}

const numbered = (count: number) =>
	Array.from({ length: count }, (_value, index) => `line ${index}`).join("\n");

afterEach(() => {
	vi.unstubAllEnvs();
	setActiveEditor(undefined);
});

describe("editorViewport", () => {
	it("finds the text rows inside the frame the editor actually drew", () => {
		const { viewport, box } = arrange(numbered(12));

		expect(viewport).toEqual({
			contentTop: CONTENT_TOP,
			contentRows: VISIBLE,
			left: 0,
			textColumn: TEXT_COLUMN,
			// The caret is on the last line, so the box is scrolled to the end:
			// 12 visual lines, 7 of them showing.
			scrollOffset: 5,
			boxTop: box.rect.y,
			boxBottom: box.rect.y + box.rect.height - 1,
		});
	});

	it("counts the padding row only when there is one", () => {
		// The dock is anchored to the bottom of the viewport, so dropping the two
		// padding rows moves the whole box *down* rather than moving the text up.
		// What holds either way is the offset from the box's own top rule.
		const padded = arrange(numbered(12), makeConfig({ editorPaddingY: 1 }));
		const bare = arrange(numbered(12), makeConfig({ editorPaddingY: 0 }));

		expect(padded.viewport.contentTop).toBe(padded.box.rect.y + 2);
		expect(bare.viewport.contentTop).toBe(bare.box.rect.y + 1);
		expect(bare.box.rect.y).toBe(padded.box.rect.y + 2);
	});

	it("shows only as many rows as the draft has", () => {
		const { viewport } = arrange("one\ntwo");

		expect(viewport.contentRows).toBe(2);
		expect(viewport.scrollOffset).toBe(0);
	});

	it("declines when there is no box", () => {
		const config = makeConfig();
		expect(
			editorViewport(makeEditor(config), undefined, {
				paddingY: 1,
				textColumn: 2,
				terminalRows: HEIGHT,
			}),
		).toBeUndefined();
	});

	it("declines for something that is not one of Pi's editors", () => {
		const { box } = arrange(numbered(12));
		expect(
			editorViewport({}, box, { paddingY: 1, textColumn: 2, terminalRows: HEIGHT }),
		).toBeUndefined();
	});
});

describe("caretPositionAt", () => {
	it("maps a click to a line and column, past the rail", () => {
		const { editor, viewport } = arrange(numbered(12));

		// Third text row, so the third line of the scrolled window: `line 7`.
		expect(caretPositionAt(editor, viewport, 4, CONTENT_TOP + 2)).toEqual({ line: 7, column: 2 });
	});

	it("clamps a click on the rail itself to column 0", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(caretPositionAt(editor, viewport, 0, CONTENT_TOP)).toEqual({ line: 5, column: 0 });
		expect(caretPositionAt(editor, viewport, 1, CONTENT_TOP)).toEqual({ line: 5, column: 0 });
	});

	it("clamps a click past the end of a line", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(caretPositionAt(editor, viewport, WIDTH - 1, CONTENT_TOP)).toEqual({
			line: 5,
			column: "line 5".length,
		});
	});

	it("returns undefined for the frame rows above and below the text", () => {
		const { editor, viewport } = arrange(numbered(12));

		for (const row of [CONTENT_TOP - 2, CONTENT_TOP - 1, CONTENT_TOP + VISIBLE, HEIGHT - 1]) {
			expect(caretPositionAt(editor, viewport, 4, row)).toBeUndefined();
		}
	});

	it("returns undefined for a click outside the box altogether", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(caretPositionAt(editor, viewport, 4, 0)).toBeUndefined();
	});
});

describe("editorSelectionText", () => {
	it("takes rows that have scrolled out of the box", () => {
		// The whole point: the box is showing visual rows 5 to 11, so lines 0 to 4
		// are not on screen at all and Pi's own copy — which reads rendered screen
		// lines — cannot reach them.
		const { editor, viewport } = arrange(numbered(12));
		expect(viewport.scrollOffset).toBe(5);

		expect(editorSelectionText(editor, { line: 0, column: 0 }, { line: 11, column: 7 })).toBe(
			numbered(12),
		);
	});

	it("slices partial first and last lines", () => {
		const { editor } = arrange("alpha\nbeta\ngamma");

		expect(editorSelectionText(editor, { line: 0, column: 2 }, { line: 2, column: 3 })).toBe(
			"pha\nbeta\ngam",
		);
	});

	it("handles a selection inside one line", () => {
		const { editor } = arrange("alpha");

		expect(editorSelectionText(editor, { line: 0, column: 1 }, { line: 0, column: 4 })).toBe("lph");
	});

	it("orders the two ends itself, so a drag upwards reads the same", () => {
		const { editor } = arrange("alpha\nbeta");

		expect(editorSelectionText(editor, { line: 1, column: 2 }, { line: 0, column: 1 })).toBe(
			"lpha\nbe",
		);
	});

	it("is empty for a range that starts past the last line", () => {
		const { editor } = arrange("alpha");

		expect(editorSelectionText(editor, { line: 4, column: 0 }, { line: 9, column: 1 })).toBe("");
	});
});

describe("editorSelectionRange", () => {
	function bounds(
		start: { row: number; col: number },
		end: { row: number; col: number; boundary?: boolean },
		scrollView?: unknown,
	) {
		return { start: { ...start, scrollView }, end: { ...end, scrollView } };
	}

	it("maps a selection lying inside the text rows", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(
			editorSelectionRange(
				editor,
				viewport,
				bounds({ row: CONTENT_TOP, col: 2 }, { row: CONTENT_TOP + 1, col: 5 }),
			),
		).toEqual({ from: { line: 5, column: 0 }, to: { line: 6, column: 4 } });
	});

	it("treats an end column as inclusive unless it is a boundary", () => {
		const { editor, viewport } = arrange(numbered(12));
		const at = (boundary: boolean) =>
			editorSelectionRange(
				editor,
				viewport,
				bounds({ row: CONTENT_TOP, col: 2 }, { row: CONTENT_TOP, col: 5, boundary }),
			)?.to;

		// Pi's own rule: a character selection covers the glyph under `end.col`,
		// a word selection (`boundary: true`) stops before it.
		expect(at(false)).toEqual({ line: 5, column: 4 });
		expect(at(true)).toEqual({ line: 5, column: 3 });
	});

	it("declines a selection in a scroll view — that is the transcript's", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(
			editorSelectionRange(
				editor,
				viewport,
				bounds({ row: CONTENT_TOP, col: 2 }, { row: CONTENT_TOP + 1, col: 5 }, {}),
			),
		).toBeUndefined();
	});

	it("declines a selection that reaches outside the box itself", () => {
		const { editor, viewport } = arrange(numbered(12));

		expect(
			editorSelectionRange(
				editor,
				viewport,
				bounds({ row: viewport.boxTop - 1, col: 2 }, { row: CONTENT_TOP + 1, col: 5 }),
			),
		).toBeUndefined();
		expect(
			editorSelectionRange(
				editor,
				viewport,
				bounds({ row: CONTENT_TOP, col: 2 }, { row: viewport.boxBottom + 1, col: 5 }),
			),
		).toBeUndefined();
	});

	it("clamps a drag that ran off the text rows but stayed in the box", () => {
		// Releasing on the top border means "from the start of the visible
		// text"; releasing on the bottom border means "through its end". The
		// column on a border row selects no text, so it is discarded either way.
		const { editor, viewport } = arrange(numbered(12));

		const fromTopBorder = editorSelectionRange(
			editor,
			viewport,
			bounds({ row: viewport.boxTop, col: 30 }, { row: CONTENT_TOP + 1, col: 5 }),
		);
		expect(fromTopBorder?.from).toEqual({ line: 5, column: 0 });
		// End col 5 is a screen column; non-boundary covers the glyph under it,
		// so the exclusive end is one cell further, minus the text column.
		expect(fromTopBorder?.to).toEqual({ line: 6, column: 4 });

		const toBottomBorder = editorSelectionRange(
			editor,
			viewport,
			bounds({ row: CONTENT_TOP, col: 2 }, { row: viewport.boxBottom, col: 3 }),
		);
		// The draft has 12 lines, 7 showing from scroll offset 5: the last
		// visible line is "line 11", and the clamp selects through its end.
		expect(toBottomBorder?.to).toEqual({ line: 11, column: "line 11".length });
	});

	it("clamps both ends of a border-only drag to the same point", () => {
		// A drag that never touched a text row — released on the border it
		// started on, say — resolves to an empty range. The copy path consumes
		// it without a clipboard write (the selection covered no text, which is
		// what Pi's own empty-text guard does too) and the delete path falls
		// through to an ordinary backspace.
		const { editor, viewport } = arrange(numbered(12));

		const range = editorSelectionRange(
			editor,
			viewport,
			bounds({ row: viewport.boxBottom, col: 2 }, { row: viewport.boxBottom, col: 8 }),
		);

		expect(range).toBeDefined();
		expect(range?.from).toEqual(range?.to);
		if (range) expect(editorSelectionText(editor, range.from, range.to)).toBe("");
	});

	it("clamps both ends of a one-row window to that row", () => {
		// `contentRows == 1`: the first and last text row are the same row, so a
		// start clamped from above and an end clamped from below meet on it.
		const { editor, viewport } = arrange(numbered(1));
		expect(viewport.contentRows).toBe(1);

		const range = editorSelectionRange(
			editor,
			viewport,
			bounds({ row: viewport.boxTop, col: 30 }, { row: viewport.boxBottom, col: 3 }),
		);

		expect(range?.from).toEqual({ line: 0, column: 0 });
		expect(range?.to).toEqual({ line: 0, column: "line 0".length });
	});

	it("keeps a wrapped logical line whole instead of breaking it at the wrap", () => {
		// Screen rows are visual lines; the buffer knows they are one line. Copying
		// from the screen puts a newline in the middle of a sentence, which is the
		// other half of what taking the text from the buffer buys.
		const line = "x".repeat(50);
		const { editor, viewport } = arrange(line);
		// A short draft makes a short box, which the bottom-anchored dock puts
		// further down the screen; the rows come from the viewport, not the
		// twelve-line fixture's.
		expect(viewport.contentRows).toBe(2);
		const top = viewport.contentTop;

		const range = editorSelectionRange(
			editor,
			viewport,
			bounds({ row: top, col: TEXT_COLUMN }, { row: top + 1, col: WIDTH - 1 }),
		);
		if (!range) throw new Error("expected an editor-local range");
		const text = editorSelectionText(editor, range.from, range.to);

		expect(text).toBe(line);
		expect(text).not.toContain("\n");
	});
});

/*
 * ---------------------------------------------------------------------------
 * The two patches, installed on one prototype.
 *
 * Both of this task's features land on a method another feature already owns:
 * `handleSelectionMouseEvent` is click-to-expand's, and
 * `copySelectionToClipboard` is the pending mode's. `installPrototypePatch`
 * holds exactly one behaviour per adapter key and silently replaces it, so a
 * second registration under either key would disable the earlier feature with
 * no error and no failing test anywhere in this suite. The scene below is what
 * makes that a caught regression rather than a discovered one: one layout
 * holding both a clickable tool box and the input box, one install with every
 * feature enabled, and assertions that each feature still does its own job
 * while the other is doing its.
 * ---------------------------------------------------------------------------
 */

/** SGR bits `parseSgrMouseEvent` produces for a plain left-button press. */
const PRESS = 0;

/**
 * The bytes a terminal sends for backspace and delete — `tui.editor
 * .deleteCharBackward` and `.deleteCharForward` as Pi's registry binds them by
 * default. Spelled out rather than derived, so a change to either default is a
 * failing test rather than a silently skipped branch.
 */
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";

/** Captured once, so the coexistence case can put the registry back. */
const originalKeybindingsForCoexistence = getKeybindings();

type FakeMouseEvent = { button: number; x: number; y: number; release?: boolean };

type SelectionPoint = { row: number; col: number; scrollView?: unknown; boundary?: boolean };
type SelectionBounds = { start: SelectionPoint; end: SelectionPoint };

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

/** The content row whose plain text contains `needle`, found not counted. */
function rowContaining(lines: readonly string[], needle: string): number {
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
	if (row < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return row;
}

/**
 * One layout holding both features' targets: a scroll view over a transcript
 * with an expandable tool box in it, and the dock with the editor in it — the
 * arrangement `interactive-mode.js` builds, laid out by pi-tui itself.
 *
 * The prototype carries every capability `capabilities.ts` lists, so
 * `installMouse` installs all six features and the two shared patches really do
 * hold two behaviours each.
 */
function makeScene(draft: string, config = makeConfig()) {
	const editor = makeEditor(config);
	editor.setText(draft);
	const editorContainer = new Container();
	editorContainer.addChild(editor as never);

	const document = new Container();
	const chat = new Container();
	document.addChild(chat);
	chat.addChild(new Text("first message", 0, 0));
	const tool = new HintedToolComponent("bash echo hi", ["out one", "out two", "out three"], 1);
	chat.addChild(tool);
	const scroll = new ScrollView(document, { primary: true });

	const written: string[] = [];
	const throughCalls: FakeMouseEvent[] = [];
	const viewportCalls: string[] = [];
	const renders: string[] = [];
	const flashes: string[] = [];
	let previousScreen: string[] = [];

	const prototype = {
		selectionBounds: undefined as SelectionBounds | undefined,
		overlay: false,
		currentLayout: { root: undefined as BoxLike | undefined },
		terminal: {
			rows: HEIGHT,
			write: (data: string) => written.push(data),
		},
		get previousScreen() {
			return previousScreen;
		},
		handleSelectionMouseEvent(event: FakeMouseEvent) {
			throughCalls.push(event);
		},
		copySelectionToClipboard() {
			// Pi's own algorithm, transcribed from `copySelectionToClipboard` in
			// tui-alt-screen.js: per row, `getSelectionColumns`, then `sliceByColumn`
			// — a *column* slice, not a UTF-16 one, which is what makes it agree
			// with the rendered width of a row carrying ANSI — then
			// `stripTerminalSequences` and `trimEnd`, joined and sent as OSC 52.
			const selection = this.getSelectionBounds();
			if (!selection) return;
			const rows: string[] = [];
			for (let row = selection.start.row; row <= selection.end.row; row++) {
				const line = previousScreen[row] ?? "";
				const columns = this.getSelectionColumns(line, row, selection);
				rows.push(
					stripTerminalSequences(
						sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
					).trimEnd(),
				);
			}
			const text = rows.join("\n");
			if (text.length === 0) return;
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			this.flash("Copied!");
		},
		getSelectionBounds() {
			return this.selectionBounds;
		},
		getSelectionColumns(line: string, row: number, selection: SelectionBounds) {
			return {
				start: row === selection.start.row ? selection.start.col : 0,
				end: row === selection.end.row ? selection.end.col + 1 : line.length,
			};
		},
		selectionAnchor: {} as unknown,
		selectionFocus: {} as unknown,
		handleViewportInput(data: string) {
			// Pi's own: it consumes what it recognises and lets ctrl+c through to
			// the focused component, which is what makes the interrupt work.
			viewportCalls.push(data);
			return data === "\x03" ? undefined : { consume: true };
		},
		flash(message: string) {
			flashes.push(message);
		},
		hasOverlay() {
			return this.overlay;
		},
		requestRender() {
			renders.push("render");
		},
		routeWheel() {},
		getWordSelection() {},
		getSelectionSourceLine() {
			return "";
		},
	};

	/**
	 * Lays the scene out and republishes it as `currentLayout`, the way Pi does
	 * on every frame — and captures the composited screen, which is what Pi's own
	 * copy reads and therefore what the buffer copy has to beat.
	 */
	const relayout = () => {
		const dock = new VStack([{ component: editorContainer, shrink: 1, minSize: 3 }]);
		const root = new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		const frame = renderLayoutFrame(root, WIDTH, HEIGHT, () => {}) as {
			root: BoxLike;
			lines?: string[];
		};
		prototype.currentLayout.root = frame.root;
		previousScreen = frame.lines ?? [];

		const scrollBox = (frame.root.children ?? [])[0] as BoxLike & {
			scrollContentLines?: readonly string[];
		};
		const contentBox = (scrollBox.children ?? [])[0];
		const contentLines = scrollBox.scrollContentLines ?? [];
		const box = editorBoxFor(frame.root, editor);
		if (!box || !contentBox) throw new Error("the scene did not lay out");
		return {
			/** Screen y of the transcript content row containing `needle`. */
			hintY: (needle: string) => contentBox.rect.y + rowContaining(contentLines, needle),
			/** Screen y of text row `index` of the input box. */
			textY: (index: number) => box.rect.y + 1 + (config.editorPaddingY > 0 ? 1 : 0) + index,
			box,
		};
	};

	return {
		editor,
		tool,
		prototype,
		written,
		throughCalls,
		viewportCalls,
		renders,
		flashes,
		relayout,
		config,
	};
}

describe("the two features that share handleSelectionMouseEvent", () => {
	const originalKeybindings = getKeybindings();
	let dispose: (() => void) | undefined;

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setKeybindings(originalKeybindings);
		setActiveEditor(undefined);
	});

	function install(scene: ReturnType<typeof makeScene>) {
		setKeybindings(
			new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }) as never,
		);
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		dispose = installMouse(scene.prototype, { getConfig: () => scene.config });
	}

	function press(scene: ReturnType<typeof makeScene>, x: number, y: number) {
		scene.prototype.handleSelectionMouseEvent({ button: PRESS, x, y, release: false });
	}

	it("runs both behaviours from one install, neither shadowing the other", () => {
		// The regression this exists for: `installPrototypePatch` keeps one
		// behaviour per adapter key, so registering click-to-caret under
		// `mouse-selection-event` as a second patch would have silently disabled
		// click-to-expand — with every other test in the suite still green,
		// because no other test has both features live at once.
		const scene = makeScene(numbered(12));
		install(scene);
		const { hintY, textY } = scene.relayout();

		// Click-to-expand, on a row in the transcript.
		press(scene, 4, hintY("to expand"));
		expect(scene.tool.expanded).toBe(true);
		// It consumed the press, so Pi never saw it.
		expect(scene.throughCalls).toHaveLength(0);

		// Click-to-caret, on a row in the input box — same install, same patch.
		press(scene, 4, textY(2));
		expect(scene.editor.getCursor()).toEqual({ line: 7, col: 2 });
		// It did *not* consume: Pi still gets the press and drops its anchor.
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("still expands when a press in the transcript follows one in the editor", () => {
		// Order must not matter: each press is resolved from scratch.
		const scene = makeScene(numbered(12));
		install(scene);
		const first = scene.relayout();

		press(scene, 4, first.textY(0));
		expect(scene.editor.getCursor()).toEqual({ line: 5, col: 2 });

		const second = scene.relayout();
		press(scene, 4, second.hintY("to expand"));
		expect(scene.tool.expanded).toBe(true);
	});

	it("leaves a press outside the input box alone", () => {
		const scene = makeScene(numbered(12));
		install(scene);
		const { textY } = scene.relayout();
		const before = scene.editor.getCursor();

		// The top rule of the box, one row above its first text row.
		press(scene, 4, textY(-1));
		// A row in the transcript that is not a hint row.
		press(scene, 4, 0);

		expect(scene.editor.getCursor()).toEqual(before);
		expect(scene.tool.expanded).toBe(false);
		expect(scene.throughCalls).toHaveLength(2);
	});

	it("leaves the caret alone when editorClickCursor is off", () => {
		const scene = makeScene(numbered(12), makeConfig({ editorClickCursor: false }));
		install(scene);
		const { textY } = scene.relayout();
		const before = scene.editor.getCursor();

		press(scene, 4, textY(2));

		expect(scene.editor.getCursor()).toEqual(before);
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("leaves the caret alone for a press aimed at an overlay", () => {
		const scene = makeScene(numbered(12));
		install(scene);
		const { textY } = scene.relayout();
		scene.prototype.overlay = true;
		const before = scene.editor.getCursor();

		press(scene, 4, textY(2));

		expect(scene.editor.getCursor()).toEqual(before);
		expect(scene.throughCalls).toHaveLength(1);
	});

	it("leaves the caret alone for a drag and for a release", () => {
		// Only the press opens a selection, so only the press moves the caret;
		// a drag that happens to cross the box must not drag the caret with it.
		const scene = makeScene(numbered(12));
		install(scene);
		const { textY } = scene.relayout();
		const before = scene.editor.getCursor();

		scene.prototype.handleSelectionMouseEvent({ button: 32, x: 4, y: textY(2) });
		scene.prototype.handleSelectionMouseEvent({ button: PRESS, x: 4, y: textY(2), release: true });

		expect(scene.editor.getCursor()).toEqual(before);
		expect(scene.throughCalls).toHaveLength(2);
	});

	it("puts both patches back on dispose", () => {
		const scene = makeScene(numbered(12));
		const original = scene.prototype.handleSelectionMouseEvent;
		install(scene);
		expect(scene.prototype.handleSelectionMouseEvent).not.toBe(original);

		dispose?.();
		dispose = undefined;

		expect(scene.prototype.handleSelectionMouseEvent).toBe(original);
	});
});

describe("the two features that share copySelectionToClipboard", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setActiveEditor(undefined);
	});

	function install(scene: ReturnType<typeof makeScene>) {
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		dispose = installMouse(scene.prototype, { getConfig: () => scene.config });
	}

	/** A selection over two whole text rows of the input box. */
	function selectTextRows(
		scene: ReturnType<typeof makeScene>,
		textY: (index: number) => number,
		first: number,
		last: number,
	) {
		scene.prototype.selectionBounds = {
			start: { row: textY(first), col: TEXT_COLUMN },
			end: { row: textY(last), col: WIDTH - 1 },
		};
	}

	it("copies the draft's own text, not the rendered rows", () => {
		const scene = makeScene(numbered(12), makeConfig({ mouse: { ...defaultConfig.mouse } }));
		install(scene);
		const { textY } = scene.relayout();
		selectTextRows(scene, textY, 0, 1);

		scene.prototype.copySelectionToClipboard();

		// Rows 0 and 1 of the visible window are visual lines 5 and 6.
		expect(decodeOsc52(scene.written[0])).toBe("line 5\nline 6");
		// And Pi's own copy of the very same selection drags the rail along.
		expect(scene.prototype.previousScreen[textY(0)]).toContain("│");
		expect(scene.flashes).toEqual(["Copied!"]);
	});

	it("reaches a row the box has scrolled out of view", () => {
		// The box shows visual lines 5 to 11. Line 11 is the last row of the
		// window; a selection ending there copies from the buffer, which is the
		// same text whether or not the row is still on screen when ctrl+c lands.
		const scene = makeScene(numbered(12), makeConfig({ mouse: { ...defaultConfig.mouse } }));
		install(scene);
		const { textY } = scene.relayout();
		selectTextRows(scene, textY, 0, VISIBLE - 1);

		scene.prototype.copySelectionToClipboard();

		expect(decodeOsc52(scene.written[0])).toBe(
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11"].join("\n"),
		);
	});

	it("lets Pi copy a selection that is not the input box's", () => {
		const scene = makeScene(numbered(12), makeConfig({ mouse: { ...defaultConfig.mouse } }));
		install(scene);
		scene.relayout();
		// Anchored in the transcript's scroll view: the transcript's to answer.
		scene.prototype.selectionBounds = {
			start: { row: 0, col: 0, scrollView: {} },
			end: { row: 0, col: 4, scrollView: {} },
		};

		scene.prototype.copySelectionToClipboard();

		// Pi's own path ran: it reads previousScreen, which has no row 0 content
		// for a scroll-view selection, so what matters is that our path declined
		// rather than answering with editor text.
		expect(scene.written.map(decodeOsc52).join("")).not.toContain("line ");
	});

	it("arms the pending hint with the buffer's count, and ctrl+c delivers it", () => {
		// Both features live on this one patch. The hint promises a character
		// count; the copy has to deliver exactly that many, which it can only do
		// if the arming path measures the same text the copying path sends.
		const scene = makeScene(
			numbered(12),
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		const { textY } = scene.relayout();
		selectTextRows(scene, textY, 0, 1);

		scene.prototype.copySelectionToClipboard(); // release: arms, copies nothing

		expect(scene.written).toEqual([]);
		expect(activeSelectionHintText()).toBe(
			`${"line 5\nline 6".length} characters selected, ctrl+c to copy`,
		);

		scene.prototype.handleViewportInput("\x03");

		expect(decodeOsc52(scene.written[0])).toBe("line 5\nline 6");
		expect(activeSelectionHintText()).toBeNull();
	});

	it("still arms with Pi's own count for a selection outside the input box", () => {
		// The pending mode is not shadowed by the buffer copy: a selection the
		// editor declines still arms, and still arms with the screen text's length.
		const scene = makeScene(
			numbered(12),
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		scene.relayout();
		scene.prototype.selectionBounds = {
			start: { row: 0, col: 0 },
			end: { row: 0, col: 4 },
		};

		scene.prototype.copySelectionToClipboard();

		const screenRow = stripTerminalSequences(scene.prototype.previousScreen[0] ?? "").slice(0, 5);
		expect(activeSelectionHintText()).toBe(
			`${screenRow.trimEnd().length} characters selected, ctrl+c to copy`,
		);
	});

	it("puts both patches back on dispose", () => {
		const scene = makeScene(numbered(12));
		const originalCopy = scene.prototype.copySelectionToClipboard;
		const originalInput = scene.prototype.handleViewportInput;
		install(scene);

		dispose?.();
		dispose = undefined;

		expect(scene.prototype.copySelectionToClipboard).toBe(originalCopy);
		expect(scene.prototype.handleViewportInput).toBe(originalInput);
		expect(activeSelectionHintText()).toBeNull();
	});
});

describe("the overlay guard is asked by both halves of the copy patch", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setActiveEditor(undefined);
	});

	it("measures and copies the same text when a dialog covers the box", () => {
		// A selection can exist over an overlay — Pi resolves no scroll view then,
		// so its rows are plain screen rows and can coincide with the input box's.
		// If only one of the two paths asked `hasOverlay`, the hint would promise
		// a count from the draft while ctrl+c sent the dialog's pixels, or the
		// other way round.
		const scene = makeScene(
			numbered(12),
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		dispose = installMouse(scene.prototype, { getConfig: () => scene.config });
		const { textY } = scene.relayout();
		scene.prototype.overlay = true;
		scene.prototype.selectionBounds = {
			start: { row: textY(0), col: TEXT_COLUMN },
			end: { row: textY(1), col: WIDTH - 1 },
		};

		scene.prototype.copySelectionToClipboard(); // arms
		const armed = activeSelectionHintText();
		scene.prototype.handleViewportInput("\x03");
		const copied = decodeOsc52(scene.written[0] ?? "");

		expect(armed).toBe(`${copied.length} characters selected, ctrl+c to copy`);
		// And it is Pi's screen text, not the draft's, because a dialog is up.
		expect(copied).not.toBe("line 5\nline 6");
	});
});

describe("deleteEditorSelection", () => {
	afterEach(() => setActiveEditor(undefined));

	/** Pi's own bounds for a screen selection over the input box's text rows. */
	function boundsOver(
		viewport: { contentTop: number },
		fromRow: number,
		fromCol: number,
		toRow: number,
		toCol: number,
	) {
		return {
			start: { row: viewport.contentTop + fromRow, col: fromCol },
			end: { row: viewport.contentTop + toRow, col: toCol },
		};
	}

	function receiverFor(scene: { prototype: { currentLayout: { root: BoxLike | undefined } } }) {
		return scene.prototype as unknown as {
			currentLayout?: { root: BoxLike };
			terminal?: { rows?: number };
		};
	}

	it("removes a range spanning two logical lines", () => {
		const scene = makeScene("alpha beta\ngamma delta\nepsilon");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		// "beta" on the first line through "gamma " on the second: Pi's end column
		// is inclusive, so col 5 covers the space after "gamma".
		const deleted = deleteEditorSelection(
			receiverFor(scene),
			scene.config,
			boundsOver(resolved.viewport, 0, TEXT_COLUMN + 6, 1, TEXT_COLUMN + 5),
		);

		expect(deleted).toBe(true);
		expect(scene.editor.getLines()).toEqual(["alpha delta", "epsilon"]);
		// The caret lands where the range started, which is where typing resumes.
		expect(scene.editor.getCursor()).toEqual({ line: 0, col: 6 });
	});

	it("removes a range inside one line", () => {
		const scene = makeScene("alpha beta gamma");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		deleteEditorSelection(
			receiverFor(scene),
			scene.config,
			boundsOver(resolved.viewport, 0, TEXT_COLUMN + 6, 0, TEXT_COLUMN + 10),
		);

		expect(scene.editor.getLines()).toEqual(["alpha gamma"]);
	});

	it("is one undo step, not one per character", () => {
		// Deleting through `handleForwardDelete` would otherwise push a snapshot
		// per grapheme and leave ctrl+z walking the range back one letter at a
		// time. One press has to put the whole thing back.
		const scene = makeScene("alpha beta\ngamma delta");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		deleteEditorSelection(
			receiverFor(scene),
			scene.config,
			boundsOver(resolved.viewport, 0, TEXT_COLUMN + 6, 1, TEXT_COLUMN + 5),
		);
		expect(scene.editor.getLines()).toEqual(["alpha delta"]);

		// `undo` is private on Pi's `Editor`; a user reaches it with ctrl+z, and a
		// test reaches it the same way the class does.
		(scene.editor as unknown as { undo(): void }).undo();

		expect(scene.editor.getLines()).toEqual(["alpha beta", "gamma delta"]);
	});

	it("declines a selection anchored in a scroll view", () => {
		const scene = makeScene("alpha beta");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");
		const bounds = boundsOver(resolved.viewport, 0, TEXT_COLUMN, 0, TEXT_COLUMN + 4);

		const deleted = deleteEditorSelection(receiverFor(scene), scene.config, {
			start: { ...bounds.start, scrollView: {} },
			end: { ...bounds.end, scrollView: {} },
		});

		expect(deleted).toBe(false);
		expect(scene.editor.getLines()).toEqual(["alpha beta"]);
	});

	it("declines a selection that reaches outside the box itself", () => {
		const scene = makeScene("alpha beta");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		const deleted = deleteEditorSelection(receiverFor(scene), scene.config, {
			start: { row: resolved.viewport.boxTop - 1, col: 0 },
			end: { row: resolved.viewport.contentTop, col: TEXT_COLUMN + 4 },
		});

		expect(deleted).toBe(false);
		expect(scene.editor.getLines()).toEqual(["alpha beta"]);
	});

	it("deletes through the end of the text when the drag ends on the bottom border", () => {
		// The reported bug: a multi-line drag released at the bottom edge of the
		// box — border or metadata row, both outside the text rows — fell
		// through to Pi and deleted one character. The clamp makes it the range
		// delete the highlight promised.
		const scene = makeScene("alpha beta\ngamma delta\nepsilon");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		const deleted = deleteEditorSelection(receiverFor(scene), scene.config, {
			start: { row: resolved.viewport.contentTop, col: TEXT_COLUMN + 6 },
			end: { row: resolved.viewport.boxBottom, col: 1 },
		});

		expect(deleted).toBe(true);
		expect(scene.editor.getLines()).toEqual(["alpha "]);
	});

	it("declines an empty range rather than reporting a delete", () => {
		const scene = makeScene("alpha beta");
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");

		// Pi never produces a collapsed selection (`getSelectionBounds` returns
		// undefined for one), but a range that resolves to no characters must not
		// consume the key either.
		const deleted = deleteEditorSelection(receiverFor(scene), scene.config, {
			start: { row: resolved.viewport.contentTop, col: 0 },
			end: { row: resolved.viewport.contentTop, col: 0, boundary: true },
		});

		expect(deleted).toBe(false);
		expect(scene.editor.getLines()).toEqual(["alpha beta"]);
	});

	it("keeps a wrapped logical line one line", () => {
		// The range is expressed in buffer positions, so deleting across a wrap
		// must not leave a newline where the screen happened to break the row.
		const line = "x".repeat(50);
		const scene = makeScene(line);
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		scene.relayout();
		const resolved = activeEditorViewport(receiverFor(scene), scene.config);
		if (!resolved) throw new Error("no viewport");
		expect(resolved.viewport.contentRows).toBe(2);

		deleteEditorSelection(
			receiverFor(scene),
			scene.config,
			boundsOver(resolved.viewport, 0, TEXT_COLUMN, 1, WIDTH - 1),
		);

		expect(scene.editor.getLines()).toEqual([""]);
	});
});

describe("the two features that share handleViewportInput", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setActiveEditor(undefined);
	});

	function install(scene: ReturnType<typeof makeScene>) {
		setActiveEditor({ component: scene.editor, scrollable: scene.editor });
		dispose = installMouse(scene.prototype, { getConfig: () => scene.config });
	}

	/** A selection over the first two text rows of the input box. */
	function selectFirstRows(scene: ReturnType<typeof makeScene>, textY: (i: number) => number) {
		scene.prototype.selectionBounds = {
			start: { row: textY(0), col: TEXT_COLUMN },
			end: { row: textY(1), col: WIDTH - 1 },
		};
	}

	it("BACKSPACE over a live editor selection removes the whole range", () => {
		const scene = makeScene("alpha beta\ngamma delta\nepsilon zeta");
		install(scene);
		const { textY } = scene.relayout();
		scene.prototype.selectionBounds = {
			start: { row: textY(0), col: TEXT_COLUMN + 6 },
			end: { row: textY(1), col: TEXT_COLUMN + 5 },
		};

		const result = scene.prototype.handleViewportInput(BACKSPACE);

		expect(result).toEqual({ consume: true });
		expect(scene.editor.getLines()).toEqual(["alpha delta", "epsilon zeta"]);
		// The highlight described text that no longer exists.
		expect(scene.prototype.selectionAnchor).toBeUndefined();
		expect(scene.prototype.selectionFocus).toBeUndefined();
	});

	it("DELETE over a live editor selection removes the whole range too", () => {
		const scene = makeScene("alpha beta\ngamma delta");
		install(scene);
		const { textY } = scene.relayout();
		scene.prototype.selectionBounds = {
			start: { row: textY(0), col: TEXT_COLUMN + 6 },
			end: { row: textY(1), col: TEXT_COLUMN + 5 },
		};

		const result = scene.prototype.handleViewportInput(DELETE);

		expect(result).toEqual({ consume: true });
		expect(scene.editor.getLines()).toEqual(["alpha delta"]);
	});

	it("leaves an ordinary backspace to Pi when nothing is selected", () => {
		// The behaviour that must not break: with no selection the key falls
		// through and the editor deletes one character, as it always has.
		const scene = makeScene("alpha beta");
		install(scene);
		scene.relayout();
		scene.prototype.selectionBounds = undefined;

		const result = scene.prototype.handleViewportInput(BACKSPACE);

		expect(result).toEqual({ consume: true }); // predecessor's answer, not ours
		expect(scene.viewportCalls).toEqual([BACKSPACE]);
		expect(scene.editor.getLines()).toEqual(["alpha beta"]);
	});

	it("leaves backspace to Pi when the selection is the transcript's", () => {
		const scene = makeScene("alpha beta");
		install(scene);
		scene.relayout();
		scene.prototype.selectionBounds = {
			start: { row: 0, col: 0, scrollView: {} },
			end: { row: 0, col: 4, scrollView: {} },
		};

		scene.prototype.handleViewportInput(BACKSPACE);

		expect(scene.viewportCalls).toEqual([BACKSPACE]);
		expect(scene.editor.getLines()).toEqual(["alpha beta"]);
	});

	it("NEVER swallows ctrl+c with nothing pending, even with a live selection", () => {
		// The single outcome that could block this release. Range delete shares
		// this method with the pending mode, and `tui.editor.deleteCharForward`
		// binds ctrl+d by default — so both interrupt chords are refused outright
		// by `isRangeDeleteKey`, before any selection is even looked at.
		const scene = makeScene("alpha beta\ngamma delta");
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY); // a live, editor-local selection

		scene.viewportCalls.length = 0;
		const ctrlC = scene.prototype.handleViewportInput("\x03");
		scene.prototype.handleViewportInput("\x04");

		// Both reached Pi. Neither was consumed by range delete.
		expect(scene.viewportCalls).toEqual(["\x03", "\x04"]);
		// Pi's own handler returns undefined for ctrl+c, which is exactly what
		// lets it fall through to the focused component and interrupt.
		expect(ctrlC).toBeUndefined();
		expect(scene.editor.getLines()).toEqual(["alpha beta", "gamma delta"]);
	});

	it("still copies on ctrl+c when a selection is pending", () => {
		// The pending mode is not shadowed by range delete sharing its patch.
		const scene = makeScene(
			"alpha beta\ngamma delta",
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);

		scene.prototype.copySelectionToClipboard(); // release: arms
		expect(activeSelectionHintText()).not.toBeNull();
		scene.prototype.handleViewportInput("\x03");

		expect(decodeOsc52(scene.written[0] ?? "")).toBe("alpha beta\ngamma delta");
		expect(activeSelectionHintText()).toBeNull();
		// And the draft is untouched — ctrl+c copied, it did not delete.
		expect(scene.editor.getLines()).toEqual(["alpha beta", "gamma delta"]);
	});

	it("copies on ctrl+c sent as an xterm modifyOtherKeys sequence", () => {
		// Pi 0.84 negotiates the Kitty keyboard protocol and falls back to
		// modifyOtherKeys, under which the chord is CSI 27;5;99~ rather than the
		// bare \x03. The pending copy must recognise the encoded form or ctrl+c
		// falls through to Pi's `app.clear` exactly when it was about to copy.
		const scene = makeScene(
			"alpha beta\ngamma delta",
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);

		scene.prototype.copySelectionToClipboard(); // release: arms
		expect(activeSelectionHintText()).not.toBeNull();
		scene.prototype.handleViewportInput("\x1b[27;5;99~");

		expect(decodeOsc52(scene.written[0] ?? "")).toBe("alpha beta\ngamma delta");
		expect(activeSelectionHintText()).toBeNull();
	});

	it("copies on ctrl+c sent as a Kitty keyboard protocol sequence", () => {
		// The same chord under the Kitty protocol: CSI 99;5u.
		const scene = makeScene(
			"alpha beta\ngamma delta",
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);

		scene.prototype.copySelectionToClipboard(); // release: arms
		expect(activeSelectionHintText()).not.toBeNull();
		scene.prototype.handleViewportInput("\x1b[99;5u");

		expect(decodeOsc52(scene.written[0] ?? "")).toBe("alpha beta\ngamma delta");
		expect(activeSelectionHintText()).toBeNull();
	});

	it("clears a pending arm when the range it described is deleted", () => {
		const scene = makeScene(
			"alpha beta\ngamma delta",
			makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
		);
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);
		scene.prototype.copySelectionToClipboard(); // arms
		expect(activeSelectionHintText()).not.toBeNull();

		scene.prototype.handleViewportInput(BACKSPACE);

		// A hint offering to copy text that has been deleted would be a lie, and
		// a stale arm makes the next ctrl+c consume an interrupt for a no-op copy.
		expect(activeSelectionHintText()).toBeNull();
	});

	it("arms an editor selection with the external-editor hint, a transcript one without", () => {
		// The editor selection cannot grow past the visible window — there is no
		// drag-scroll — so its pending hint points at `app.editor.external`,
		// spelled the way this session has it bound. A transcript selection can
		// scroll and needs no such pointer.
		const original = getKeybindings();
		setKeybindings(
			new KeybindingsManager({ "app.editor.external": { defaultKeys: "ctrl+g" } }) as never,
		);
		try {
			const scene = makeScene(
				"alpha beta\ngamma delta",
				makeConfig({ mouse: { ...defaultConfig.mouse, copyOnSelect: false } }),
			);
			install(scene);
			const { textY } = scene.relayout();
			selectFirstRows(scene, textY);

			scene.prototype.copySelectionToClipboard(); // release: arms

			// Unset EDITOR keeps the literal variable name in the hint.
			vi.stubEnv("EDITOR", "");
			expect(activeSelectionHintText()).toMatch(
				/characters selected, ctrl\+c to copy ⋅ ctrl\+g to edit in \$EDITOR$/,
			);
			// With $EDITOR set, the hint names the editor it would open.
			vi.stubEnv("EDITOR", "/usr/bin/nvim");
			expect(activeSelectionHintText()).toMatch(
				/characters selected, ctrl\+c to copy ⋅ ctrl\+g to edit in nvim$/,
			);

			// A transcript selection arms the plain hint.
			scene.prototype.handleViewportInput("\x03"); // copies and clears
			const scrollView = (
				scene.prototype.currentLayout.root?.children?.[0] as { scrollView?: unknown }
			)?.scrollView;
			scene.prototype.selectionBounds = {
				start: { row: 0, col: 0, scrollView },
				end: { row: 0, col: 4, scrollView },
			};
			scene.prototype.copySelectionToClipboard();
			const hint = activeSelectionHintText();
			expect(hint).not.toBeNull();
			expect(hint).not.toContain("$EDITOR");
		} finally {
			setKeybindings(original);
		}
	});

	it("offers the external-editor hint once the draft outgrows the box", () => {
		// No drag-scroll, so a draft taller than the box is partly unreachable by
		// mouse; that is when the hint points at the external editor, refreshed
		// by the same input path that sees the draft change.
		const original = getKeybindings();
		setKeybindings(
			new KeybindingsManager({ "app.editor.external": { defaultKeys: "ctrl+g" } }) as never,
		);
		try {
			const scene = makeScene(numbered(12), makeConfig());
			install(scene);
			scene.relayout();

			// Nothing has landed on `handleViewportInput` yet, so no refresh.
			expect(externalEditorHintText()).toBeNull();
			// Unset EDITOR keeps the literal variable name in the hint.
			vi.stubEnv("EDITOR", "");
			scene.prototype.handleViewportInput("x");
			expect(externalEditorHintText()).toBe("ctrl+g to edit in $EDITOR");
			// With $EDITOR set, the hint names the editor it would open.
			vi.stubEnv("EDITOR", "/opt/homebrew/bin/nvim");
			scene.prototype.handleViewportInput("x");
			expect(externalEditorHintText()).toBe("ctrl+g to edit in nvim");
		} finally {
			setKeybindings(original);
		}
	});

	it("stays quiet while the draft fits the box", () => {
		const scene = makeScene("alpha beta\ngamma delta", makeConfig());
		install(scene);
		scene.relayout();
		scene.prototype.handleViewportInput("x");
		expect(externalEditorHintText()).toBeNull();
	});

	it("leaves the range alone when editorClickCursor is off", () => {
		const scene = makeScene("alpha beta\ngamma delta", makeConfig({ editorClickCursor: false }));
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);

		scene.prototype.handleViewportInput(BACKSPACE);

		expect(scene.viewportCalls).toEqual([BACKSPACE]);
		expect(scene.editor.getLines()).toEqual(["alpha beta", "gamma delta"]);
	});

	it("leaves the range alone for a backspace while a dialog is up", () => {
		const scene = makeScene("alpha beta\ngamma delta");
		install(scene);
		const { textY } = scene.relayout();
		selectFirstRows(scene, textY);
		scene.prototype.overlay = true;

		scene.prototype.handleViewportInput(BACKSPACE);

		expect(scene.editor.getLines()).toEqual(["alpha beta", "gamma delta"]);
	});

	it("all six features coexist: expand, caret, copy and range delete", () => {
		// Every feature installed at once, exercising all three shared patches in
		// one session. Reproducing any adapter-key collision turns this red.
		const scene = makeScene("alpha beta\ngamma delta\nepsilon zeta");
		// Pi's real defaults plus the expand binding: this case needs the editor's
		// own delete bindings present as well as `app.tools.expand`, because both
		// shared patches are exercised in the one session.
		setKeybindings(
			new KeybindingsManager({
				...TUI_KEYBINDINGS,
				"app.tools.expand": { defaultKeys: "ctrl+o" },
			}) as never,
		);
		install(scene);
		const first = scene.relayout();

		// mouse-selection-event, behaviour 1: click-to-expand.
		scene.prototype.handleSelectionMouseEvent({
			button: 0,
			x: 4,
			y: first.hintY("to expand"),
			release: false,
		});
		expect(scene.tool.expanded).toBe(true);

		// mouse-selection-event, behaviour 2: click-to-caret.
		const second = scene.relayout();
		scene.prototype.handleSelectionMouseEvent({
			button: 0,
			x: TEXT_COLUMN + 6,
			y: second.textY(0),
			release: false,
		});
		expect(scene.editor.getCursor()).toEqual({ line: 0, col: 6 });

		// mouse-copy: the draft's own text, not the rendered rows.
		scene.prototype.selectionBounds = {
			start: { row: second.textY(0), col: TEXT_COLUMN },
			end: { row: second.textY(1), col: WIDTH - 1 },
		};
		scene.prototype.copySelectionToClipboard();
		expect(decodeOsc52(scene.written[0] ?? "")).toBe("alpha beta\ngamma delta");

		// mouse-viewport-input, behaviour 2: range delete.
		scene.prototype.selectionBounds = {
			start: { row: second.textY(0), col: TEXT_COLUMN + 6 },
			end: { row: second.textY(1), col: TEXT_COLUMN + 5 },
		};
		scene.prototype.handleViewportInput(BACKSPACE);
		expect(scene.editor.getLines()).toEqual(["alpha delta", "epsilon zeta"]);

		// mouse-viewport-input, behaviour 1: ctrl+c still reaches Pi.
		scene.viewportCalls.length = 0;
		scene.prototype.handleViewportInput("\x03");
		expect(scene.viewportCalls).toEqual(["\x03"]);

		setKeybindings(originalKeybindingsForCoexistence);
	});
});
