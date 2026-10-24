import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type Component,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { applyEditorCursorStyleToLines } from "./editor-cursor";
import { renderEditorMetadataFormat } from "./editor-metadata-format";
import { collectExtensionStatusSegments } from "./extension-status";
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

/**
 * The key this package used before it was renamed from pi-zentui. Read, never
 * written as the primary key: if both packages are loaded in the same
 * session, a base editor built by either one must still resolve the
 * splitter, or the wrapper double-renders the inner frame instead of
 * unwrapping it. See the alias assignments after each class below, which
 * expose the splitter under this key too so the reverse direction resolves.
 */
const LEGACY_SPLIT_POLISHED_FRAME: unique symbol = Symbol.for("pi-zentui.polished-frame");

type PolishedFrameSplit = {
	editorLines: string[];
	trailingLines: string[];
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
		[LEGACY_SPLIT_POLISHED_FRAME]?: (lines: string[]) => PolishedFrameSplit | undefined;
	};

type EditorMeta = {
	modelLabel: string;
	modelId?: string;
	modelName?: string;
	providerLabel: string;
	sessionName?: string;
};

type PolishedFrameOptions = {
	width: number;
	baseRendered: string[];
	autocompleteSource: AutocompleteEditorInternals;
	uiTheme: Theme;
	config: PolishedTuiConfig;
	modelMeta: EditorMeta;
	thinkingLevel: string | undefined;
	rightStatus?: string;
	/** Third-party statuses placed on the editor row (`placement: "editor"`). */
	editorStatus?: string;
	/** Pi's status text for the top rule (retry, compaction, …). */
	borderStatus?: string;
	/** Draft lines scrolled out of view above / below, for Pi's `↑ N more` cue. */
	scrollTop?: number;
	scrollBottom?: number;
	/** Reports how many text rows the frame drew, so `handleMouse` can bound clicks. */
	onEditorLines?: (count: number) => void;
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
 * The right side of the metadata row: vim mode, third-party statuses placed
 * there, and the paste/selection hints.
 *
 * The hint used to live on the editor's bottom border, drawn there by the fixed
 * editor's compositor. Pi 0.84 supersedes the fixed editor, so the hint needs a
 * home that does not depend on it — and the border is not it, because
 * `isHorizontalBorder` requires an unbroken rule to find the frame again. The
 * metadata row is always rendered, even when `editorMetadataFormat` is blank,
 * so the hint shows up whatever the user has done to that template.
 *
 * Hints come last: `composeMetadataLine` truncates this string from the right
 * when it cannot fit, and the hints are the transient, actionable part.
 */
function composeRightStatus(
	vimStatus: string | undefined,
	editorStatus: string | undefined,
	uiTheme: Theme,
): string | undefined {
	// A live selection hint already spells the external editor out ("N
	// characters selected, ctrl+x to copy ⋅ ctrl+g to edit in $EDITOR"), so it
	// takes precedence; the always-on hint only speaks when nothing else does.
	const hint = composeHints(
		pasteExpandHintText(),
		activeSelectionHintText() ?? externalEditorHintText(),
	);
	const styled = hint ? safeThemeFg(uiTheme, "muted", hint) : undefined;
	const parts = [vimStatus, editorStatus, styled].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(" ⋅ ") : undefined;
}

/**
 * Statuses configured with `placement: "editor"`, joined for the metadata row.
 *
 * The row is one muted line like the hints beside it, so the per-status colours
 * and icons (footer features) are not applied here; `colorMode: "original"`
 * text keeps whatever the extension already styled it with.
 */
function editorStatusText(
	config: PolishedTuiConfig,
	uiTheme: Theme,
	statuses: ReadonlyMap<string, string> | undefined,
): string | undefined {
	if (!statuses || statuses.size === 0) return undefined;
	const segments = collectExtensionStatusSegments(statuses, config).editor;
	if (segments.length === 0) return undefined;
	return segments
		.map((segment) =>
			segment.colorMode === "original" ? segment.text : safeThemeFg(uiTheme, "muted", segment.text),
		)
		.join(" ⋅ ");
}

function composeMetadataLine(left: string, right: string | undefined, width: number): string {
	if (!right) return left;
	const maxWidth = Math.max(0, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= maxWidth) return truncateToWidth(right, maxWidth, "");

	const leftWidth = Math.max(0, maxWidth - rightWidth - 1);
	const leftText = truncateToWidth(left, leftWidth, "");
	const gap = " ".repeat(Math.max(1, maxWidth - visibleWidth(leftText) - rightWidth));
	return `${leftText}${gap}${right}`;
}

function plainRenderedText(line: string): string {
	return line
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\[\/?[^\]]+\]/g, "");
}

function isHorizontalBorder(line: string): boolean {
	const plain = plainRenderedText(line).trim();
	return plain.length > 0 && /^─+$/.test(plain);
}

function unwrapPolishedFrameOnly(
	lines: string[],
	config: PolishedTuiConfig,
	uiTheme: Theme,
): string[] | undefined {
	// The frame is parsed back by position, so the padding the renderer emitted has
	// to be the padding assumed here.
	const padY = config.editorPaddingY > 0 ? 1 : 0;
	if (
		lines.length < 4 + padY ||
		!isHorizontalBorder(lines[0] ?? "") ||
		!isHorizontalBorder(lines.at(-1) ?? "")
	)
		return undefined;

	const interior = lines.slice(1, -1);
	if (interior.length < 2 + padY) return undefined;

	if (config.features.copyFriendly) {
		if (
			(padY > 0 && plainRenderedText(interior[0] ?? "").trim() !== "") ||
			(padY > 0 && plainRenderedText(interior.at(-2) ?? "").trim() !== "") ||
			!(interior.at(-1) ?? "").startsWith(" ")
		)
			return undefined;

		const { prompt, promptWidth } = getEditorChromeWidths(config, uiTheme, "\x1b[0m");
		const continuation = " ".repeat(promptWidth);
		const content = interior.slice(padY, -(1 + padY));
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
	if (
		padY > 0 &&
		(plainRenderedText(unrailed[0] ?? "").trim() !== "" ||
			plainRenderedText(unrailed.at(-2) ?? "").trim() !== "")
	)
		return undefined;
	return unrailed.slice(padY, -(1 + padY));
}

function splitPolishedFrame(
	lines: string[],
	config: PolishedTuiConfig,
	uiTheme: Theme,
): PolishedFrameSplit | undefined {
	if (!isHorizontalBorder(lines[0] ?? "")) return undefined;
	for (let bottomIndex = lines.length - 1; bottomIndex >= 4; bottomIndex--) {
		if (!isHorizontalBorder(lines[bottomIndex] ?? "")) continue;
		const editorLines = unwrapPolishedFrameOnly(lines.slice(0, bottomIndex + 1), config, uiTheme);
		if (editorLines) {
			return { editorLines, trailingLines: lines.slice(bottomIndex + 1) };
		}
	}
	return undefined;
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
 * Two things can share the rule: Pi's status text on the left (`── ⠋ Retrying (1/3)
 * ────`), and the draft's scroll position, centred in Pi's own ` ↑ 3 more `
 * wording. The status wins when both cannot fit — it is the one carrying a cancel
 * hint — and the scroll label is dropped rather than pushed off-centre.
 *
 * The status arrives already coloured by Pi, so only the rule and the label are
 * painted here.
 */
function composeBorderLine(
	width: number,
	parts: { status?: string; scroll?: string },
	border: (text: string) => string,
): string {
	const rule = (count: number) => border("─".repeat(Math.max(0, count)));
	if (width <= 0) return rule(width);

	const status = parts.status ? truncateToWidth(parts.status, Math.max(1, width - 5), "") : "";
	const statusWidth = visibleWidth(status);
	const leftWidth = statusWidth > 0 ? statusWidth + 4 : 0;

	const label = parts.scroll ? ` ${parts.scroll} ` : "";
	const labelWidth = visibleWidth(label);
	const labelStart = labelWidth > 0 ? Math.floor((width - labelWidth) / 2) : -1;
	const centred =
		labelWidth > 0 && labelStart >= leftWidth + 1 && labelStart + labelWidth <= width - 1;
	// A label that cannot be centred still beats dropping it, but only when there
	// is no status competing for the left of the rule.
	const rightAligned = labelWidth > 0 && !centred && leftWidth === 0 && labelWidth + 2 <= width;

	let out = statusWidth > 0 ? `${border("── ")}${status}${border(" ")}` : "";
	let cursor = leftWidth;
	if (centred) {
		out += rule(labelStart - cursor) + border(label);
		cursor = labelStart + labelWidth;
	} else if (rightAligned) {
		out += rule(width - labelWidth) + border(label);
		cursor = width;
	}
	return out + rule(width - cursor);
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

/** The shape of a Pi TUI mouse event, local so it survives an older pi-tui type surface. */
export type FrameMouseEvent = {
	type?: string;
	button?: string;
	x: number;
	y: number;
	width: number;
	height?: number;
	[key: string]: unknown;
};

/**
 * Map a click in Starline's frame onto the coordinates Pi's own editor expects.
 *
 * Pi counts from its own frame: `y = 1` is the first text row, `x = 0` is the box's
 * left edge, and `width` is the whole box. Starline's frame puts a rail (or a
 * copy-friendly prompt) in front of every row, pads above the text when
 * `editorPaddingY` is on, and adds a metadata row below it.
 *
 * Returns undefined for anything outside the text block. The borders and the
 * metadata row are Starline's, and Pi would otherwise read a click on the bottom
 * rule as a click in its autocomplete list — which it draws immediately after that
 * rule in its own frame, but two rows earlier in ours.
 */
export function translateEditorMouse(
	event: FrameMouseEvent,
	geometry: { railWidth: number; padTop: number; editorLineCount: number },
): FrameMouseEvent | undefined {
	const { railWidth, padTop, editorLineCount } = geometry;
	if (editorLineCount <= 0) return undefined;
	const y = event.y - padTop;
	if (!Number.isFinite(y) || y < 1 || y > editorLineCount) return undefined;
	return {
		...event,
		x: event.x - railWidth,
		y,
		width: Math.max(1, event.width - railWidth),
	};
}

/**
 * Pi's own click handling, resolved once at load.
 *
 * `Editor.handleMouse` only exists from pi-tui 1.4, which is newer than the type
 * surface this package builds against, so the lookup walks the prototype chain by
 * hand and simply stays undefined on older builds.
 */
const baseHandleMouse = (
	CustomEditor.prototype as unknown as {
		handleMouse?: (this: unknown, event: FrameMouseEvent) => unknown;
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
	modelMeta,
	thinkingLevel,
	rightStatus,
	editorStatus,
	borderStatus,
	scrollTop,
	scrollBottom,
	onEditorLines,
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
	onEditorLines?.(editorLines.length);
	const meta = renderEditorMetadataFormat(
		config.editorMetadataFormat,
		{
			model: modelMeta.modelLabel,
			modelId: modelMeta.modelId ?? "",
			modelName: modelMeta.modelName ?? "",
			provider: modelMeta.providerLabel,
			thinking: thinkingLevel ?? "",
			sessionName: modelMeta.sessionName ?? "",
		},
		uiTheme,
		config,
	);
	const status = composeRightStatus(rightStatus, editorStatus, uiTheme);
	const copyFriendlyMeta = composeMetadataLine(meta, status, Math.max(0, width - 1));
	const railedMeta = composeMetadataLine(meta, status, innerWidth);

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
		{ status: borderStatus, scroll: scrollLabel("↑", scrollTop) },
		borderPaint,
	);
	const bottom = composeBorderLine(width, { scroll: scrollLabel("↓", scrollBottom) }, borderPaint);
	// The metadata row stays even when it renders blank: splitPolishedFrame parses
	// the frame back by position, so changing the line count breaks the wrapped
	// editor path. An empty editorMetadataFormat leaves a blank row, not no row.
	const padRows = config.editorPaddingY > 0 ? [""] : [];
	const lines = [...padRows, ...editorLines, ...padRows, railedMeta];
	const renderedLines = config.features.copyFriendly
		? [
				top,
				...padRows,
				...editorLines.map(
					(line, index) =>
						`${index === 0 ? prompt : copyFriendlyContinuation}${fillLine(line, innerWidth)}`,
				),
				...padRows,
				` ${truncateToWidth(copyFriendlyMeta, Math.max(0, width - 1), "")}`,
				bottom,
				...autocompleteLines,
			]
		: [
				top,
				...lines.map((line) => `${rail}${fillLine(line, innerWidth)}`),
				bottom,
				...autocompleteLines,
			];

	return clampRenderedLines(renderedLines, width);
}

export class PolishedEditor extends CustomEditor {
	private readonly getModelMeta: () => EditorMeta;
	private readonly getThinkingLevel: () => string | undefined;
	private readonly getConfig: () => PolishedTuiConfig;
	private readonly uiTheme: Theme;
	private readonly getExtensionStatuses: (() => ReadonlyMap<string, string>) | undefined;
	/** Text rows the last frame drew; bounds what `handleMouse` is allowed to translate. */
	private editorLineCount = 0;
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
		getModelMeta: () => EditorMeta,
		getThinkingLevel: () => string | undefined,
		getExtensionStatuses?: () => ReadonlyMap<string, string>,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => safeThemeFg(uiTheme, "border", text);
		this.uiTheme = uiTheme;
		this.getConfig = getConfig;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
		this.getExtensionStatuses = getExtensionStatuses;
	}

	render(width: number): string[] {
		if (width <= 2) {
			return clampRenderedLines(super.render(width), width);
		}

		const config = this.getConfig();
		const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m");
		const innerWidth = Math.max(0, width - railWidth);
		const rendered = super.render(innerWidth);
		const modelMeta = this.getModelMeta();
		const result = renderPolishedFrame({
			width,
			baseRendered: rendered,
			autocompleteSource: this as unknown as AutocompleteEditorInternals,
			uiTheme: this.uiTheme,
			config,
			modelMeta,
			thinkingLevel: this.getThinkingLevel(),
			editorStatus: editorStatusText(config, this.uiTheme, this.getExtensionStatuses?.()),
			borderStatus: workingStatusForBorder(config, Math.max(1, width - 5)),
			// Pi paints the draft's scroll position into the borders it draws, and both
			// of those lines are dropped when Starline redraws the frame, so the counts
			// are read back out of them here. Works whether the base inlines the cue
			// (Pi 0.84) or routes it through renderTopBorder (Pi 1.4+).
			scrollTop: readScrollCount(rendered[0], "↑"),
			scrollBottom: readScrollCount(rendered.at(-1), "↓"),
			onEditorLines: (count) => {
				this.editorLineCount = count;
			},
		});
		return result;
	}

	/**
	 * Pi 1.4 turns a click into a caret move itself (`Editor.handleMouse`), counting
	 * rows from its own frame. Starline's frame is not that frame, so the press is
	 * translated back before Pi sees it — grapheme-accurate columns, autocomplete
	 * clicks and focus then come from Pi rather than from a patched press handler.
	 */
	handleMouse(event: FrameMouseEvent): unknown {
		if (typeof baseHandleMouse !== "function") return undefined;
		const config = this.getConfig();
		const { railWidth } = getEditorChromeWidths(config, this.uiTheme, "\x1b[0m");
		const translated = translateEditorMouse(event, {
			railWidth,
			padTop: config.editorPaddingY > 0 ? 1 : 0,
			editorLineCount: this.editorLineCount,
		});
		if (!translated) return undefined;
		return baseHandleMouse.call(this, translated);
	}

	setWorkingStatusIndicator(indicator: WorkingIndicator | undefined): void {
		setWorkingIndicator(indicator);
	}

	[SPLIT_POLISHED_FRAME](lines: string[]): PolishedFrameSplit | undefined {
		return splitPolishedFrame(lines, this.getConfig(), this.uiTheme);
	}
}
// Also resolvable under the pre-rename key, so a pi-zentui wrapper reading a
// pi-starline-built base still finds the splitter.
(PolishedEditor.prototype as unknown as Record<PropertyKey, unknown>)[LEGACY_SPLIT_POLISHED_FRAME] =
	PolishedEditor.prototype[SPLIT_POLISHED_FRAME];

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
		private readonly getModelMeta: () => EditorMeta,
		private readonly getThinkingLevel: () => string | undefined,
		private readonly getExtensionStatuses?: () => ReadonlyMap<string, string>,
	) {}

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
		const vimStatus = readVimStatus(this.base, this.uiTheme);
		const modelMeta = this.getModelMeta();
		return renderPolishedFrame({
			width,
			baseRendered: rendered,
			autocompleteSource: this.base,
			uiTheme: this.uiTheme,
			config,
			modelMeta,
			thinkingLevel: this.getThinkingLevel(),
			rightStatus: vimStatus,
			editorStatus: editorStatusText(config, this.uiTheme, this.getExtensionStatuses?.()),
			borderStatus: workingStatusForBorder(config, Math.max(1, width - 5)),
			// The base's frame lines are dropped, so its scroll cues are read back
			// from them and redrawn by Starline's own borders.
			scrollTop: readScrollCount(rendered[0], "↑"),
			scrollBottom: readScrollCount(rendered.at(-1), "↓"),
			splitBaseFrame: (
				this.base[SPLIT_POLISHED_FRAME] ?? this.base[LEGACY_SPLIT_POLISHED_FRAME]
			)?.bind(this.base),
		});
	}

	setWorkingStatusIndicator(indicator: WorkingIndicator | undefined): void {
		setWorkingIndicator(indicator);
	}

	[SPLIT_POLISHED_FRAME](lines: string[]): PolishedFrameSplit | undefined {
		return splitPolishedFrame(lines, this.getConfig(), this.uiTheme);
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
// Also resolvable under the pre-rename key, so a pi-zentui wrapper reading a
// pi-starline-built base still finds the splitter.
(WrappedPolishedEditor.prototype as unknown as Record<PropertyKey, unknown>)[
	LEGACY_SPLIT_POLISHED_FRAME
] = WrappedPolishedEditor.prototype[SPLIT_POLISHED_FRAME];
