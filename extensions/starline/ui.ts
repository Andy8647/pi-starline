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
import { activeSelectionHintText, externalEditorHintText } from "./mouse";
import { composeHints } from "./mouse/hint";
import { pasteExpandHintText } from "./paste-collapse";
import {
	EDITOR_ACCENT_FALLBACK,
	EDITOR_BORDER_FALLBACK,
	renderStyleForSourceOrFallback,
	safeThemeFg,
} from "./style";

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
 * The right side of the metadata row: vim mode, the paste-expand hint, or both.
 *
 * The hint used to live on the editor's bottom border, drawn there by the fixed
 * editor's compositor. Pi 0.84 supersedes the fixed editor, so the hint needs a
 * home that does not depend on it — and the border is not it, because
 * `isHorizontalBorder` requires an unbroken rule to find the frame again. The
 * metadata row is always rendered, even when `editorMetadataFormat` is blank,
 * so the hint shows up whatever the user has done to that template.
 */
function composeRightStatus(vimStatus: string | undefined, uiTheme: Theme): string | undefined {
	// A live selection hint already spells the external editor out ("N
	// characters selected, ctrl+c to copy ⋅ ctrl+g to edit in $EDITOR"), so it
	// takes precedence; the always-on hint only speaks when nothing else does.
	const hint = composeHints(
		pasteExpandHintText(),
		activeSelectionHintText() ?? externalEditorHintText(),
	);
	if (!hint) return vimStatus;
	const styled = safeThemeFg(uiTheme, "muted", hint);
	return vimStatus ? `${vimStatus} ⋅ ${styled}` : styled;
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
	const status = composeRightStatus(rightStatus, uiTheme);
	const copyFriendlyMeta = composeMetadataLine(meta, status, Math.max(0, width - 1));
	const railedMeta = composeMetadataLine(meta, status, innerWidth);

	const top = renderStyleForSourceOrFallback(
		uiTheme,
		colorSource,
		config.colors.editorBorder,
		EDITOR_BORDER_FALLBACK,
		"─".repeat(width),
	);
	const bottom = renderStyleForSourceOrFallback(
		uiTheme,
		colorSource,
		config.colors.editorBorder,
		EDITOR_BORDER_FALLBACK,
		"─".repeat(width),
	);
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

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		uiTheme: Theme,
		getConfig: () => PolishedTuiConfig,
		getModelMeta: () => EditorMeta,
		getThinkingLevel: () => string | undefined,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.borderColor = (text: string) => safeThemeFg(uiTheme, "border", text);
		this.uiTheme = uiTheme;
		this.getConfig = getConfig;
		this.getModelMeta = getModelMeta;
		this.getThinkingLevel = getThinkingLevel;
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
		});
		return result;
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
	constructor(
		private readonly base: WrappedEditor,
		private readonly uiTheme: Theme,
		private readonly getConfig: () => PolishedTuiConfig,
		private readonly getModelMeta: () => EditorMeta,
		private readonly getThinkingLevel: () => string | undefined,
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
			splitBaseFrame: (
				this.base[SPLIT_POLISHED_FRAME] ?? this.base[LEGACY_SPLIT_POLISHED_FRAME]
			)?.bind(this.base),
		});
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
