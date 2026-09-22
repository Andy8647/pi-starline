import { type Theme, type ThemeColor, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type MarkdownTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { installPrototypePatch } from "./prototype-patch-registry";
import {
	EDITOR_ACCENT_FALLBACK,
	EDITOR_BORDER_FALLBACK,
	renderStyleForSource,
	renderStyleForSourceOrFallback,
} from "./style";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type PatchableUserMessagePrototype = {
	children?: unknown[];
};

type Cleanup = () => void;

type UserMessageRenderCache = {
	hasMarkdownText: boolean;
	text?: string;
	width?: number;
	theme?: Theme;
	configKey?: string;
	transformers?: readonly unknown[];
	renderedLines?: string[];
};

const userMessageRenderCache = new WeakMap<object, UserMessageRenderCache>();

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findMarkdownText(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.text === "string") return value.text;

	const children = value.children;
	if (!Array.isArray(children)) return undefined;

	for (const child of children) {
		const text = findMarkdownText(child);
		if (text !== undefined) return text;
	}

	return undefined;
}

function getCachedMarkdownText(instance: object): string | undefined {
	const cached = userMessageRenderCache.get(instance);
	if (cached?.hasMarkdownText) return cached.text;

	const text = findMarkdownText(instance);
	if (text !== undefined) {
		userMessageRenderCache.set(instance, { ...cached, hasMarkdownText: true, text });
	}
	return text;
}

type MarkdownTransformerFn = (
	markdown: string,
	context: {
		messageType: "user" | "assistant" | "assistant-thinking";
		isStreaming: boolean;
		availableWidth: number;
	},
) => unknown;

/**
 * pi 官方管道:UserMessageComponent 把扩展注册的 markdownTransformers 通过
 * Markdown 的 transform 选项跑一遍(createMarkdownTransform)。我们重写了 render,
 * 必须自己把这条管道接上,否则任何 registerMarkdownTransformer 的扩展
 * (如 pi-ide-context 的选区引用行)在 starline 样式下都会被旁路。
 */
function getMarkdownTransformersRef(instance: object): readonly unknown[] | undefined {
	if (!isRecord(instance)) return undefined;
	const t = instance.markdownTransformers;
	return Array.isArray(t) ? t : undefined;
}

function applyMarkdownTransformers(
	text: string,
	availableWidth: number,
	transformers: readonly unknown[],
): string {
	let out = text;
	for (const t of transformers) {
		if (typeof t !== "function") continue;
		try {
			const r = (t as MarkdownTransformerFn)(out, {
				messageType: "user",
				isStreaming: false,
				availableWidth,
			});
			if (typeof r === "string") out = r;
		} catch {
			// 与 pi 的 applyMarkdownTransformers 一致:单个 transformer 抛错不影响其他
		}
	}
	return out;
}

function getUserMessageConfigKey(config: PolishedTuiConfig): string {
	return [
		config.features.copyFriendly ? "copy" : "chrome",
		config.colorSources.userMessages,
		config.colors.editorAccent ?? "",
		config.colors.editorBorder ?? "",
		config.colors.userMessageBorder ?? "",
		config.colors.userMessageText ?? "",
		String(config.userMessagePaddingY),
		config.icons.rail,
	].join("\0");
}

function themeFg(theme: Theme | undefined, color: ThemeColor, text: string): string {
	if (!theme) return text;
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function makeMarkdownTheme(theme: Theme | undefined): MarkdownTheme {
	return {
		heading: (text) => themeFg(theme, "mdHeading", text),
		link: (text) => themeFg(theme, "mdLink", text),
		linkUrl: (text) => themeFg(theme, "mdLinkUrl", text),
		code: (text) => themeFg(theme, "mdCode", text),
		codeBlock: (text) => themeFg(theme, "mdCodeBlock", text),
		codeBlockBorder: (text) => themeFg(theme, "mdCodeBlockBorder", text),
		quote: (text) => themeFg(theme, "mdQuote", text),
		quoteBorder: (text) => themeFg(theme, "mdQuoteBorder", text),
		hr: (text) => themeFg(theme, "mdHr", text),
		listBullet: (text) => themeFg(theme, "mdListBullet", text),
		bold: (text) => (theme ? theme.bold(text) : text),
		italic: (text) => (theme ? theme.italic(text) : text),
		underline: (text) => (theme ? theme.underline(text) : text),
		strikethrough: (text) => (theme ? theme.strikethrough(text) : text),
	};
}

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

function renderPromptBoxRail(theme: Theme | undefined, config: PolishedTuiConfig): string {
	if (config.features.copyFriendly) return "";
	const railGlyph = config.icons.rail;

	return `${
		theme
			? renderStyleForSourceOrFallback(
					theme,
					config.colorSources.userMessages,
					config.colors.editorAccent,
					EDITOR_ACCENT_FALLBACK,
					railGlyph,
				)
			: railGlyph
	} `;
}

function renderPromptBoxLine(
	line: string,
	width: number,
	theme: Theme | undefined,
	config: PolishedTuiConfig,
): string {
	if (width <= 0) return "";
	const rail = renderPromptBoxRail(theme, config);
	const contentWidth = Math.max(0, width - visibleWidth(rail));
	const content = config.features.copyFriendly
		? truncateToWidth(line, contentWidth, "")
		: fillLine(line, contentWidth);
	return truncateToWidth(`${rail}${content}`, width, "");
}

function renderStarlineUserMessage(
	instance: PatchableUserMessagePrototype,
	width: number,
	theme: Theme | undefined,
	config: PolishedTuiConfig,
): string[] | undefined {
	if (!isRecord(instance)) return undefined;

	const text = getCachedMarkdownText(instance);
	if (text === undefined) return undefined;
	if (width <= 0) return [""];

	const configKey = getUserMessageConfigKey(config);
	const transformersRef = getMarkdownTransformersRef(instance);
	const cached = userMessageRenderCache.get(instance);
	if (
		cached?.hasMarkdownText &&
		cached.width === width &&
		cached.theme === theme &&
		cached.configKey === configKey &&
		cached.transformers === transformersRef &&
		cached.renderedLines
	) {
		return cached.renderedLines;
	}

	const railWidth = visibleWidth(renderPromptBoxRail(theme, config));
	const contentWidth = Math.max(1, width - railWidth);
	const renderer = new Markdown(
		text,
		0,
		0,
		makeMarkdownTheme(theme),
		{
			color: (content) =>
				theme && config.colors.userMessageText
					? renderStyleForSource(
							theme,
							config.colorSources.userMessages,
							config.colors.userMessageText,
							content,
						)
					: themeFg(theme, "userMessageText", content),
		},
		// 接上官方 transformer 管道;Markdown 每次 render 都会按当前宽度重跑
		{
			transform: transformersRef?.length
				? (markdown, availableWidth) =>
						applyMarkdownTransformers(markdown, availableWidth, transformersRef)
				: undefined,
		},
	);
	const body = renderer.render(contentWidth);
	const contentLines = body.length > 0 ? body : [""];
	const border = theme
		? renderStyleForSourceOrFallback(
				theme,
				config.colorSources.userMessages,
				config.colors.userMessageBorder ?? config.colors.editorBorder,
				EDITOR_BORDER_FALLBACK,
				"─".repeat(width),
			)
		: "─".repeat(width);
	const padRows =
		config.userMessagePaddingY > 0 ? [renderPromptBoxLine("", width, theme, config)] : [];
	const lines = [
		truncateToWidth(border, width, ""),
		...padRows,
		...contentLines.map((line) => renderPromptBoxLine(line, width, theme, config)),
		...padRows,
		truncateToWidth(border, width, ""),
	];

	userMessageRenderCache.set(instance, {
		hasMarkdownText: true,
		text,
		width,
		theme,
		configKey,
		transformers: transformersRef,
		renderedLines: lines,
	});
	return lines;
}

function withPromptZoneMarkers(lines: string[]): string[] {
	const markedLines = [...lines];
	markedLines[0] = OSC133_ZONE_START + markedLines[0];
	markedLines[markedLines.length - 1] =
		OSC133_ZONE_END + OSC133_ZONE_FINAL + markedLines[markedLines.length - 1];
	return markedLines;
}

export function installUserMessageStyle(
	getTheme: () => Theme | undefined,
	getConfig: () => PolishedTuiConfig,
): Cleanup {
	const prototype = UserMessageComponent.prototype;
	const cleanupInvalidate = installPrototypePatch(
		prototype,
		"invalidate",
		"user-message-invalidate",
		({ predecessor, receiver, args }) => {
			if (isObject(receiver)) userMessageRenderCache.delete(receiver);
			return Reflect.apply(predecessor, receiver, args);
		},
	);
	const cleanupRender = installPrototypePatch(
		prototype,
		"render",
		"user-message-render",
		({ predecessor, receiver, args }) => {
			const width = args[0];
			if (typeof width !== "number") return Reflect.apply(predecessor, receiver, args);
			const lines = renderStarlineUserMessage(
				receiver as PatchableUserMessagePrototype,
				width,
				getTheme(),
				getConfig(),
			);
			if (!lines) return Reflect.apply(predecessor, receiver, args);
			if (lines.length === 0) return lines;
			return withPromptZoneMarkers(lines);
		},
	);
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		cleanupRender();
		cleanupInvalidate();
	};
}
