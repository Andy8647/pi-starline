import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { applyEditorCursorStyleToLines } from "./editor-cursor";
import { activeSelectionHintText, externalEditorHintText } from "./mouse";
import { composeHints } from "./mouse/hint";
import { pasteExpandHintText } from "./paste-collapse";
import {
	EDITOR_ACCENT_FALLBACK,
	EDITOR_BORDER_FALLBACK,
	renderStyleForSourceOrFallback,
	safeThemeFg,
} from "./style";
import {
	setWorkingIndicator,
	type WorkingIndicator,
	workingStatusForBorder,
} from "./working-indicator";

const SPLIT_POLISHED_FRAME: unique symbol = Symbol.for("pi-starline.polished-frame");

type PolishedFrameSplit = {
	editorLines: string[];
	trailingLines: string[];
};

/** What one render drew, kept so a wrapper can take the frame apart again. */
type DrawnFrame = PolishedFrameSplit & {
	/** The array `render` returned; a wrapper hands back this exact one. */
	lines: string[];
	/** Blank rows `editorMinRows` added below the text. */
	fillerRows: number;
};

type AutocompleteEditorInternals = {
	autocompleteList?: Pick<Component, "render">;
	isShowingAutocomplete?: () => boolean;
};

type WrappedEditor = EditorComponent &
	AutocompleteEditorInternals & {
		focused?: boolean;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
		onExtensionShortcut?: (data: string) => boolean;
		actionHandlers?: Map<unknown, () => void>;
		wantsKeyRelease?: boolean;
		disableSubmit?: boolean;
		getLines?: () => string[];
		getCursor?: () => unknown;
		getMode?: () => unknown;
		getPaddingX?: () => number;
		getAutocompleteMaxVisible?: () => number;
		addToHistory?: (text: string) => void;
		getExpandedText?: () => string;
		insertTextAtCursor?: (text: string) => void;
		setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
		setPaddingX?: (padding: number) => void;
		setAutocompleteMaxVisible?: (maxVisible: number) => void;
		[SPLIT_POLISHED_FRAME]?: (lines: string[]) => PolishedFrameSplit | undefined;
	};

type PolishedFrameOptions = {
	width: number;
	baseRendered: string[];
	autocompleteSource: AutocompleteEditorInternals;
	uiTheme: Theme;
	config: PolishedTuiConfig;
	/** A wrapped base editor's mode (`INSERT`, `NORMAL`, …), when it has one. */
	vimStatus?: string;
	/** Pi's status text for the top rule (retry, compaction, …). */
	borderStatus?: string;
	/** Draft lines scrolled out of view above / below, for Pi's `↑ N more` cue. */
	scrollTop?: number;
	scrollBottom?: number;
	/** Reports what the frame drew: `handleMouse` bounds clicks by it, a wrapper splits by it. */
	onFrame?: (frame: Omit<DrawnFrame, "lines">) => void;
	splitBaseFrame?: (lines: string[]) => PolishedFrameSplit | undefined;
};

function clampRenderedLines(lines: string[], width: number): string[] {
	const maxWidth = Math.max(0, width);
	return lines.map((line) => truncateToWidth(line, maxWidth, ""));
}

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

function copyFriendlyPrompt(config: PolishedTuiConfig, uiTheme: Theme, reset: string): string {
	const promptIcon = config.icons.editorPrompt;
	return promptIcon
		? `${renderStyleForSourceOrFallback(
				uiTheme,
				config.colorSources.editor,
				config.colors.editorPrompt ?? config.colors.editorAccent,
				EDITOR_ACCENT_FALLBACK,
				promptIcon,
			)}${reset} `
		: "";
}

function getEditorChromeWidths(config: PolishedTuiConfig, uiTheme: Theme, reset: string) {
	const prompt = copyFriendlyPrompt(config, uiTheme, reset);
	const rail = config.features.copyFriendly
		? ""
		: `${renderStyleForSourceOrFallback(
				uiTheme,
				config.colorSources.editor,
				config.colors.editorAccent,
				EDITOR_ACCENT_FALLBACK,
				config.icons.rail,
			)}${reset} `;
	return {
		prompt,
		promptWidth: visibleWidth(prompt),
		rail,
		railWidth: config.features.copyFriendly ? visibleWidth(prompt) : visibleWidth(rail),
	};
}

/**
 * The right end of the top rule: a wrapped editor's vim mode, then the paste
 * and selection hints.
 *
 * Until 0.9 these sat on a metadata row under the text, which made the box a
 * row taller than Pi's even with nothing to say. The top rule is there anyway,
 * and nothing else claims its right end — Pi's status text starts at the left,
 * the scroll cue is centred — so the box stays the height of its text.
 */
function composeTopRightStatus(vimStatus: string | undefined, uiTheme: Theme): string | undefined {
	// A live selection hint already spells the external editor out ("N
	// characters selected, ctrl+x to copy ⋅ ctrl+g to edit in $EDITOR"), so it
	// takes precedence; the always-on hint only speaks when nothing else does.
	const hint = composeHints(
		pasteExpandHintText(),
		activeSelectionHintText() ?? externalEditorHintText(),
	);
	const styled = hint ? safeThemeFg(uiTheme, "muted", hint) : undefined;
	const parts = [vimStatus, styled].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(" ⋅ ") : undefined;
}

function plainRenderedText(line: string): string {
	return line
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\[\/?[^\]]+\]/g, "");
}

/**
 * A frame rule, possibly with text riding on it (`── ⠋ Retrying ──── hint ──`):
 * it starts and ends with rule glyphs. Rail rows start with the rail and
 * autocomplete rows with text, so neither matches.
 */
function isHorizontalBorder(line: string): boolean {
	const plain = plainRenderedText(line).trim();
	return plain.length > 1 && plain.startsWith("─") && plain.endsWith("─");
}

/**
 * Take a Starline frame apart from its lines alone. Only the fallback for
 * `splitPolishedFrame` — an editor normally answers from what it drew — so it
 * cannot tell `editorMinRows` filler from blank draft lines and keeps both.
 */
function unwrapPolishedFrameOnly(
	lines: string[],
	config: PolishedTuiConfig,
	uiTheme: Theme,
): string[] | undefined {
	// The frame is parsed back by position, so the padding the renderer emitted has
	// to be the padding assumed here.
	const padY = config.editorPaddingY > 0 ? 1 : 0;
	if (
		lines.length < 3 + 2 * padY ||
		!isHorizontalBorder(lines[0] ?? "") ||
		!isHorizontalBorder(lines.at(-1) ?? "")
	)
		return undefined;

	const interior = lines.slice(1, -1);
	const isBlank = (line: string | undefined) => plainRenderedText(line ?? "").trim() === "";

	if (config.features.copyFriendly) {
		if (padY > 0 && (!isBlank(interior[0]) || !isBlank(interior.at(-1)))) return undefined;
		const { prompt, promptWidth } = getEditorChromeWidths(config, uiTheme, "\x1b[0m");
		const continuation = " ".repeat(promptWidth);
		const content = interior.slice(padY, interior.length - padY);
		const unwrapped: string[] = [];
		for (let index = 0; index < content.length; index++) {
			const prefix = index === 0 ? prompt : continuation;
			const line = content[index] ?? "";
			if (prefix && !line.startsWith(prefix)) return undefined;
			unwrapped.push(prefix ? line.slice(prefix.length) : line);
		}
		return unwrapped;
	}

	const { rail } = getEditorChromeWidths(config, uiTheme, "\x1b[0m");
	if (!rail || interior.some((line) => !line.startsWith(rail))) return undefined;
	const unrailed = interior.map((line) => line.slice(rail.length));
	if (padY > 0 && (!isBlank(unrailed[0]) || !isBlank(unrailed.at(-1)))) return undefined;
	return unrailed.slice(padY, unrailed.length - padY);
}

function splitPolishedFrame(
	lines: string[],
	config: PolishedTuiConfig,
	uiTheme: Theme,
): PolishedFrameSplit | undefined {
	if (!isHorizontalBorder(lines[0] ?? "")) return undefined;
	for (let bottomIndex = lines.length - 1; bottomIndex >= 2; bottomIndex--) {
		if (!isHorizontalBorder(lines[bottomIndex] ?? "")) continue;
		const editorLines = unwrapPolishedFrameOnly(lines.slice(0, bottomIndex + 1), config, uiTheme);
		if (editorLines) {
			return { editorLines, trailingLines: lines.slice(bottomIndex + 1) };
		}
	}
	return undefined;
}

/**
 * Split a frame this editor drew. A wrapper hands back the very array `render`
 * returned, so the frame is known exactly — text rows apart from padding and
 * `editorMinRows` filler, whatever rides on the rules. Lines from anywhere else
 * go through the positional parse.
 */
function splitDrawnFrame(
	drawn: DrawnFrame | undefined,
	lines: string[],
	config: PolishedTuiConfig,
	uiTheme: Theme,
): PolishedFrameSplit | undefined {
	if (drawn && drawn.lines === lines) {
		return { editorLines: drawn.editorLines, trailingLines: drawn.trailingLines };
	}
	return splitPolishedFrame(lines, config, uiTheme);
}

function vimModeColor(mode: string): string {
	switch (mode.toLowerCase()) {
		case "insert":
			return "success";
		case "normal":
			return "accent";
		case "ex":
			return "warning";
		case "replace":
			return "error";
		case "visual":
			return "syntaxKeyword";
		default:
			return "muted";
	}
}

/**
 * A frame rule with things riding on it.
 *
 * Three things can share the rule: Pi's status text on the left (`── ⠋ Retrying
 * (1/3) ────`), hints on the right (`──── 12 characters selected ──`), and the
 * draft's scroll position, centred in Pi's own ` ↑ 3 more ` wording. When they
 * cannot all fit, the status wins (it carries a cancel hint), then the right
 * side, which is cut from its end; the scroll label is dropped rather than
 * pushed off-centre.
 *
 * The status and hints arrive already coloured, so only the rule and the label
 * are painted here.
 */
function composeBorderLine(
	width: number,
	parts: { status?: string; scroll?: string; right?: string },
	border: (text: string) => string,
): string {
	const rule = (count: number) => border("─".repeat(Math.max(0, count)));
	if (width <= 0) return rule(width);

	const status = parts.status ? truncateToWidth(parts.status, Math.max(1, width - 5), "") : "";
	const statusWidth = visibleWidth(status);
	const leftWidth = statusWidth > 0 ? statusWidth + 4 : 0;

	// ` hint ──`, kept clear of the status by at least one rule cell.
	const rightRoom = width - leftWidth - 1 - 4;
	const right = parts.right && rightRoom >= 1 ? truncateToWidth(parts.right, rightRoom, "") : "";
	const rightTextWidth = visibleWidth(right);
	const rightWidth = rightTextWidth > 0 ? rightTextWidth + 4 : 0;

	const label = parts.scroll ? ` ${parts.scroll} ` : "";
	const labelWidth = visibleWidth(label);
	const labelStart = labelWidth > 0 ? Math.floor((width - labelWidth) / 2) : -1;
	const centred =
		labelWidth > 0 &&
		labelStart >= leftWidth + 1 &&
		labelStart + labelWidth <= width - rightWidth - 1;
	// A label that cannot be centred still beats dropping it, but only when there
	// is nothing else on the rule competing for its ends.
	const rightAligned =
		labelWidth > 0 && !centred && leftWidth === 0 && rightWidth === 0 && labelWidth + 2 <= width;

	let out = statusWidth > 0 ? `${border("── ")}${status}${border(" ")}` : "";
	let cursor = leftWidth;
	const end = width - rightWidth;
	if (centred) {
		out += rule(labelStart - cursor) + border(label);
		cursor = labelStart + labelWidth;
	} else if (rightAligned) {
		out += rule(width - labelWidth) + border(label);
		cursor = width;
	}
	out += rule(end - cursor);
	return rightWidth > 0 ? `${out}${border(" ")}${right}${border(" ──")}` : out;
}

/** Pi's own wording for the border scroll cue. */
function scrollLabel(direction: "↑" | "↓", count: number | undefined): string | undefined {
	return count && count > 0 ? `${direction} ${count} more` : undefined;
}

/**
 * Read back the count Pi painted into a border line. The wrapped editor drops the
 * base's frame lines, so this is how a base editor's scroll cue survives.
 */
function readScrollCount(line: string | undefined, direction: "↑" | "↓"): number {
	if (!line) return 0;
	const match = new RegExp(`${direction}\\s+(\\d+)\\s+more`).exec(plainRenderedText(line));
	return match ? Number(match[1]) : 0;
}

/**
 * The fields of a Pi mouse event the frame translation reads. Generic callers
 * pass the whole `TuiMouseEvent` and get the same type back.
 */
export type FrameMouseEvent = {
	x: number;
	y: number;
	width: number;
};

/**
 * Map a click in Starline's frame onto the coordinates Pi's own editor expects.
 *
 * Pi counts from its own frame: `y = 1` is the first text row, `x = 0` is the box's
 * left edge, and `width` is the whole box. Starline's frame puts a rail (or a
 * copy-friendly prompt) in front of every row, pads above and below the text when
 * `editorPaddingY` is on, and follows a short draft with `editorMinRows` filler.
 *
 * A click on a filler row lands at the end of the last text row, as a click
 * past the end of a line does. Anything else outside the text block returns
 * undefined: the borders and padding are Starline's, and Pi would otherwise read
 * a click on the bottom rule as a click in its autocomplete list — which it
 * draws immediately after that rule in its own frame, but rows earlier in ours.
 */
export function translateEditorMouse<Event extends FrameMouseEvent>(
	event: Event,
	geometry: { railWidth: number; padTop: number; editorLineCount: number; fillerRows?: number },
): Event | undefined {
	const { railWidth, padTop, editorLineCount, fillerRows = 0 } = geometry;
	if (editorLineCount <= 0) return undefined;
	const row = event.y - padTop;
	if (!Number.isFinite(row) || row < 1 || row > editorLineCount + fillerRows) return undefined;
	const width = Math.max(1, event.width - railWidth);
	const filler = row > editorLineCount;
	return {
		...event,
		x: filler ? width - 1 : event.x - railWidth,
		y: filler ? editorLineCount : row,
		width,
	};
}

/**
 * Pi's own click handling, resolved once at load.
 *
 * `Editor.handleMouse` only exists from pi-tui 1.4. The peer floor is older, so
 * the lookup is a plain property read that stays undefined on those builds rather
 * than a call the type system assumes is there.
 */
const baseHandleMouse = (
	CustomEditor.prototype as {
		handleMouse?: (this: unknown, event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	}
).handleMouse;

function readVimStatus(editor: WrappedEditor, uiTheme: Theme): string | undefined {
	const mode = editor.getMode?.();
	if (typeof mode !== "string") return undefined;
	const normalized = mode.trim();
	if (!normalized) return undefined;
	const label = `${normalized.toUpperCase()} `;
	return safeThemeFg(uiTheme, vimModeColor(normalized), label);
}

function renderPolishedFrame({
	width,
	baseRendered,
	autocompleteSource,
	uiTheme,
	config,
	vimStatus,
	borderStatus,
	scrollTop,
	scrollBottom,
	onFrame,
	splitBaseFrame,
}: PolishedFrameOptions): string[] {
	if (width <= 2) return clampRenderedLines(baseRendered, width);

	const reset = "\x1b[0m";
	const colorSource = config.colorSources.editor;
	const { prompt, promptWidth, rail, railWidth } = getEditorChromeWidths(config, uiTheme, reset);
	const innerWidth = Math.max(0, width - railWidth);
	const copyFriendlyContinuation = " ".repeat(promptWidth);
	const isShowingAutocomplete =
		typeof autocompleteSource.isShowingAutocomplete === "function"
			? Boolean(autocompleteSource.isShowingAutocomplete())
			: false;

	if (baseRendered.length < 2) return clampRenderedLines(baseRendered, width);

	const ownedFrame = splitBaseFrame?.(baseRendered);
	const { autocompleteList } = autocompleteSource;
	const autocompleteCount =
		!ownedFrame && isShowingAutocomplete && typeof autocompleteList?.render === "function"
			? autocompleteList.render(innerWidth).length
			: 0;
	const editorFrame =
		!ownedFrame && autocompleteCount > 0 && autocompleteCount < baseRendered.length
			? baseRendered.slice(0, -autocompleteCount)
			: baseRendered;
	const autocompleteLines = ownedFrame
		? ownedFrame.trailingLines
		: autocompleteCount > 0 && autocompleteCount < baseRendered.length
			? baseRendered.slice(-autocompleteCount)
			: [];
	if (editorFrame.length < 2) return clampRenderedLines(baseRendered, width);

	const editorLines = applyEditorCursorStyleToLines(
		ownedFrame?.editorLines ?? editorFrame.slice(1, -1),
		config.editorCursor,
	);
	const fillerRows = Math.max(0, config.editorMinRows - editorLines.length);
	onFrame?.({ editorLines, trailingLines: autocompleteLines, fillerRows });

	const borderPaint = (text: string) =>
		renderStyleForSourceOrFallback(
			uiTheme,
			colorSource,
			config.colors.editorBorder,
			EDITOR_BORDER_FALLBACK,
			text,
		);
	const top = composeBorderLine(
		width,
		{
			status: borderStatus,
			scroll: scrollLabel("↑", scrollTop),
			right: composeTopRightStatus(vimStatus, uiTheme),
		},
		borderPaint,
	);
	const bottom = composeBorderLine(width, { scroll: scrollLabel("↓", scrollBottom) }, borderPaint);
	const padRows = config.editorPaddingY > 0 ? [""] : [];
	const fillRows = Array.from({ length: fillerRows }, () => "");
	const renderedLines = config.features.copyFriendly
		? [
				top,
				...padRows,
				...editorLines.map(
					(line, index) =>
						`${index === 0 ? prompt : copyFriendlyContinuation}${fillLine(line, innerWidth)}`,
				),
				...fillRows,
				...padRows,
				bottom,
				...autocompleteLines,
			]
		: [
				top,
				...[...padRows, ...editorLines, ...fillRows, ...padRows].map(
					(line) => `${rail}${fillLine(line, innerWidth)}`,
				),
				bottom,
				...autocompleteLines,
			];

	return clampRenderedLines(renderedLines, width);
}

export class PolishedEditor extends CustomEditor {
	private readonly getConfig: () => PolishedTuiConfig;
	private readonly uiTheme: Theme;
	/** The last frame drawn: bounds what `handleMouse` translates, and answers a wrapper's split. */
	private lastFrame: DrawnFrame | undefined;
	/**
	 * Pi only routes a status to the editor when it advertises this flag, and stops
	 * drawing its own row above the editor. Starline wants that deal so the plain
	 * spinner can sit in the model pill; see `working-indicator.ts`. The base class
	 * never sees the indicator (starline does not forward it), so the border it
	 * would draw stays a plain rule and this frame stays the only one.
	 */
	readonly embedWorkingStatus = true;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getConfig: () => PolishedTuiConfig,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => safeThemeFg(uiTheme, "border", text);
		this.uiTheme = uiTheme;
		this.getConfig = getConfig;
	}

	render(width: number): string[] {
		if (width <= 2) {
			return clampRenderedLines(super.render(width), width);
		}

		const config = this.getConfig();
		const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m");
		const innerWidth = Math.max(0, width - railWidth);
		const rendered = super.render(innerWidth);
		let drawn: Omit<DrawnFrame, "lines"> | undefined;
		const result = renderPolishedFrame({
			width,
			baseRendered: rendered,
			autocompleteSource: this as unknown as AutocompleteEditorInternals,
			uiTheme: this.uiTheme,
			config,
			borderStatus: workingStatusForBorder(config, Math.max(1, width - 5)),
			// Pi paints the draft's scroll position into the borders it draws, and both
			// of those lines are dropped when Starline redraws the frame, so the counts
			// are read back out of them here. Works whether the base inlines the cue
			// (Pi 0.84) or routes it through renderTopBorder (Pi 1.4+).
			scrollTop: readScrollCount(rendered[0], "↑"),
			scrollBottom: readScrollCount(rendered.at(-1), "↓"),
			onFrame: (frame) => {
				drawn = frame;
			},
		});
		this.lastFrame = drawn && { ...drawn, lines: result };
		return result;
	}

	/**
	 * Pi 1.4 turns a click into a caret move itself (`Editor.handleMouse`), counting
	 * rows from its own frame. Starline's frame is not that frame, so the press is
	 * translated back before Pi sees it — grapheme-accurate columns, autocomplete
	 * clicks and focus then come from Pi rather than from a patched press handler.
	 */
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (typeof baseHandleMouse !== "function") return undefined;
		const config = this.getConfig();
		const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m");
		const translated = translateEditorMouse(event, {
			railWidth,
			padTop: config.editorPaddingY > 0 ? 1 : 0,
			editorLineCount: this.lastFrame?.editorLines.length ?? 0,
			fillerRows: this.lastFrame?.fillerRows ?? 0,
		});
		if (!translated) return undefined;
		return baseHandleMouse.call(this, translated);
	}

	setWorkingStatusIndicator(indicator: WorkingIndicator | undefined): void {
		setWorkingIndicator(indicator);
	}

	[SPLIT_POLISHED_FRAME](lines: string[]): PolishedFrameSplit | undefined {
		return splitDrawnFrame(this.lastFrame, lines, this.getConfig(), this.uiTheme);
	}
}

export class WrappedPolishedEditor implements EditorComponent {
	/**
	 * Same contract as `PolishedEditor`: see the note there. The wrapper is what Pi
	 * mounts, so the wrapper is what has to advertise it.
	 */
	readonly embedWorkingStatus = true;

	constructor(
		private readonly base: WrappedEditor,
		private readonly uiTheme: Theme,
		private readonly getConfig: () => PolishedTuiConfig,
	) {}

	private lastFrame: DrawnFrame | undefined;

	get focused(): boolean {
		return Boolean(this.base.focused);
	}
	set focused(value: boolean) {
		this.base.focused = value;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}
	set borderColor(value: ((str: string) => string) | undefined) {
		this.base.borderColor = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}
	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}
	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}

	get onEscape(): (() => void) | undefined {
		return this.base.onEscape;
	}
	set onEscape(value: (() => void) | undefined) {
		this.base.onEscape = value;
	}

	get onCtrlD(): (() => void) | undefined {
		return this.base.onCtrlD;
	}
	set onCtrlD(value: (() => void) | undefined) {
		this.base.onCtrlD = value;
	}

	get onPasteImage(): (() => void) | undefined {
		return this.base.onPasteImage;
	}
	set onPasteImage(value: (() => void) | undefined) {
		this.base.onPasteImage = value;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this.base.onExtensionShortcut;
	}
	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
		this.base.onExtensionShortcut = value;
	}

	get actionHandlers(): Map<unknown, () => void> | undefined {
		return this.base.actionHandlers;
	}
	set actionHandlers(value: Map<unknown, () => void> | undefined) {
		this.base.actionHandlers = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}
	set wantsKeyRelease(value: boolean | undefined) {
		this.base.wantsKeyRelease = value;
	}

	get disableSubmit(): boolean | undefined {
		return this.base.disableSubmit;
	}
	set disableSubmit(value: boolean | undefined) {
		this.base.disableSubmit = value;
	}

	render(width: number): string[] {
		if (width <= 2) return clampRenderedLines(this.base.render(width), width);

		const config = this.getConfig();
		const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m");
		const innerWidth = Math.max(0, width - railWidth);
		const rendered = this.base.render(innerWidth);
		let drawn: Omit<DrawnFrame, "lines"> | undefined;
		const result = renderPolishedFrame({
			width,
			baseRendered: rendered,
			autocompleteSource: this.base,
			uiTheme: this.uiTheme,
			config,
			vimStatus: readVimStatus(this.base, this.uiTheme),
			borderStatus: workingStatusForBorder(config, Math.max(1, width - 5)),
			// The base's frame lines are dropped, so its scroll cues are read back
			// from them and redrawn by Starline's own borders.
			scrollTop: readScrollCount(rendered[0], "↑"),
			scrollBottom: readScrollCount(rendered.at(-1), "↓"),
			splitBaseFrame: this.base[SPLIT_POLISHED_FRAME]?.bind(this.base),
			onFrame: (frame) => {
				drawn = frame;
			},
		});
		this.lastFrame = drawn && { ...drawn, lines: result };
		return result;
	}

	setWorkingStatusIndicator(indicator: WorkingIndicator | undefined): void {
		setWorkingIndicator(indicator);
	}

	[SPLIT_POLISHED_FRAME](lines: string[]): PolishedFrameSplit | undefined {
		return splitDrawnFrame(this.lastFrame, lines, this.getConfig(), this.uiTheme);
	}

	invalidate(): void {
		this.base.invalidate?.();
	}

	handleInput(data: string): void {
		this.base.handleInput(data);
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	getLines(): string[] {
		return this.base.getLines?.() ?? this.base.getText().split("\n");
	}

	getCursor(): unknown {
		return this.base.getCursor?.();
	}

	getMode(): unknown {
		return this.base.getMode?.();
	}

	getPaddingX(): number | undefined {
		return this.base.getPaddingX?.();
	}

	getAutocompleteMaxVisible(): number | undefined {
		return this.base.getAutocompleteMaxVisible?.();
	}
}
