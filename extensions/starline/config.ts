import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type EditorCursorStyle, parseEditorCursorStyle } from "./editor-cursor";
import {
	ICON_GLYPH_KEYS,
	type IconGlyphs,
	type IconMode,
	NERD_DEFAULT_ICONS,
	normalizeIconMode,
	type ResolvedIcons,
	resolveConfiguredIcons,
} from "./icons";
import {
	DEFAULT_PILL_CONFIG,
	type FooterStyle,
	normalizePillConfig,
	type PillConfig,
	parseFooterStyle,
} from "./pill-config";
import { isSupportedColorSpec } from "./style";

export type ColorSpec = string;
export type ColorSource = "theme" | "terminal";
export type { IconMode } from "./icons";

export type ContextStyle = "text" | "gauge" | "text+gauge";
/** How much the context segment spells out. Orthogonal to ContextStyle. */
export type ContextFormat = "full" | "percent";
/** What the tokens segment shows for cache activity. */
export type TokensCacheFormat = "percent" | "tokens" | "off";

export type SegmentOptionsConfig = {
	context: { format: ContextFormat };
	tokens: { cache: TokensCacheFormat };
};
export type SeparatorStyle = "pipe" | "dot" | "chevron" | "none";
export type ModelLabelSource = "id" | "name";

export type ContextThresholds = {
	warning: number;
	error: number;
};

export type PathDisplayMode = "basename" | "full";

export type PathDisplayConfig = {
	mode: PathDisplayMode;
	/** Trailing directories to show in full mode. 0 = unlimited; clamped to 0..5. */
	depth: number;
};

export type GitBranchMaxLength = "full" | number;

export type GitBranchConfig = {
	maxLength: GitBranchMaxLength;
};

export type ColorSourcesConfig = {
	starship: ColorSource;
	editor: ColorSource;
	userMessages: ColorSource;
};

export type UiFeaturesConfig = {
	editor: boolean;
	statusLine: boolean;
	copyFriendly: boolean;
};

export type FooterSegmentsConfig = {
	model: boolean;
	thinking: boolean;
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCounts: boolean;
	gitCommit: boolean;
	gitMetrics: boolean;
	runtime: boolean;
	context: boolean;
	tokens: boolean;
	cacheHit: boolean;
	cost: boolean;
	sessionDuration: boolean;
	username: boolean;
	time: boolean;
	os: boolean;
	packageVersion: boolean;
};

export type MouseConfig = {
	enabled: boolean;
	wheelRouting: boolean;
	/** Show a "copied to clipboard" notice for a copy Starline itself performs. */
	copyNotice: boolean;
	/** Copy on mouse release. When false the highlight waits for ctrl+c. */
	copyOnSelect: boolean;
	/** Clicking a tool box's `ctrl+o to expand` hint expands that one box. */
	clickToExpandTools: boolean;
	/** Double/triple-click word selection stops at path separators. */
	pathAwareWords: boolean;
	/** Copy transcript selections without the painted rails, rules and frames. */
	transcriptCleanCopy: boolean;
};

const FIXED_EDITOR_KEY_MAP: Record<string, keyof MouseConfig> = {
	enabled: "enabled",
	mouseScroll: "wheelRouting",
	copyNotice: "copyNotice",
	copyOnSelect: "copyOnSelect",
	clickToExpandTools: "clickToExpandTools",
};

/**
 * Carry a 0.2.x `fixedEditor` block over to `mouse`.
 *
 * The old name described a compositor that no longer exists. Anything already
 * written under `mouse` was set deliberately and outranks what is being
 * migrated.
 */
export function migrateFixedEditorKeys(raw: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const legacy = raw.fixedEditor;
	if (!legacy || typeof legacy !== "object") return { config: raw, migrated: false };

	const existing = (typeof raw.mouse === "object" && raw.mouse !== null ? raw.mouse : {}) as Record<
		string,
		unknown
	>;
	const mouse: Record<string, unknown> = { ...existing };
	for (const [oldKey, newKey] of Object.entries(FIXED_EDITOR_KEY_MAP)) {
		const value = (legacy as Record<string, unknown>)[oldKey];
		if (value !== undefined && !(newKey in mouse)) mouse[newKey] = value;
	}

	const { fixedEditor: _dropped, ...rest } = raw;
	return { config: { ...rest, mouse }, migrated: true };
}

export type ExtensionStatusPlacement = "off" | "left" | "middle" | "right";
export type ExtensionStatusColorMode = "themed" | "original";

/**
 * Starship `git_commit`-style options.
 * See https://starship.rs/config/#git-commit
 */
export type GitCommitConfig = {
	hashLength: number;
	onlyDetached: boolean;
	showTag: boolean;
};

/**
 * Starship `git_metrics`-style options.
 * See https://starship.rs/config/#git-metrics
 */
export type GitMetricsConfig = {
	onlyNonzero: boolean;
	ignoreSubmodules: boolean;
};

const DEFAULT_EXTENSION_STATUS_COLOR_MODE: ExtensionStatusColorMode = "themed";

export type ExtensionStatusesConfig = {
	defaultPlacement: ExtensionStatusPlacement;
	placements: Record<string, ExtensionStatusPlacement>;
	colorModes: Record<string, ExtensionStatusColorMode>;
	/** Per-status colour, keyed by status key. Falls back to colors.extensionStatus. */
	colors: Record<string, ColorSpec>;
	/** Per-status icon, keyed by status key. Prefixed to the status text. */
	icons: Record<string, string>;
};

const DEFAULT_PROJECT_REFRESH_INTERVAL_MS = 30_000;
const MIN_PROJECT_REFRESH_INTERVAL_MS = 5_000;
export const DEFAULT_EDITOR_METADATA_FORMAT = "$model  $provider(  $thinking)";

export type PolishedTuiConfig = {
	projectRefreshIntervalMs: number;
	/** "text" renders footerFormat as before; "pill" renders pill.segments instead. */
	footerStyle: FooterStyle;
	pill: PillConfig;
	footerFormat: string;
	editorMetadataFormat: string;
	separator: SeparatorStyle;
	contextStyle: ContextStyle;
	segmentOptions: SegmentOptionsConfig;
	editorModelLabel: ModelLabelSource;
	editorCursor: EditorCursorStyle;
	/** Clicking in the editor text moves the caret there. Needs `mouse.enabled`. */
	editorClickCursor: boolean;
	/** Collapse pastes at this many lines. 11 (default) leaves Pi's threshold alone. */
	pasteCollapseLines: number;
	/** Blank rows inside the editor box, above the input and above the metadata row. */
	editorPaddingY: number;
	/** Blank rows inside the previous-message box, above and below the body. */
	userMessagePaddingY: number;
	contextThresholds: ContextThresholds;
	pathDisplay: PathDisplayConfig;
	gitBranch: GitBranchConfig;
	/** Replace the branch icon with the origin remote's forge logo. */
	gitHostIcon: boolean;
	icons: ResolvedIcons;
	colors: {
		model: ColorSpec;
		/** Unset derives the colour from the level via the theme's thinking* keys. */
		thinking?: ColorSpec;
		cwd: ColorSpec;
		sessionName: ColorSpec;
		gitBranch: ColorSpec;
		gitStatus: ColorSpec;
		contextNormal: ColorSpec;
		contextWarning: ColorSpec;
		contextError: ColorSpec;
		tokens: ColorSpec;
		cacheHit: ColorSpec;
		cost: ColorSpec;
		separator: ColorSpec;
		runtimePrefix: ColorSpec;
		extensionStatus: ColorSpec;
		sessionDuration: ColorSpec;
		packageVersion: ColorSpec;
		gitCommit: ColorSpec;
		gitMetricsAdded: ColorSpec;
		gitMetricsDeleted: ColorSpec;
		username: ColorSpec;
		time: ColorSpec;
		os: ColorSpec;
		editorAccent?: ColorSpec;
		editorPrompt?: ColorSpec;
		editorBorder?: ColorSpec;
		/** Unset falls back to editorBorder, which is upstream's behaviour. */
		userMessageBorder?: ColorSpec;
		/** Unset follows the theme's userMessageText colour. */
		userMessageText?: ColorSpec;
		editorModel?: ColorSpec;
		editorProvider?: ColorSpec;
		editorThinking?: ColorSpec;
		editorThinkingMinimal?: ColorSpec;
		editorThinkingLow?: ColorSpec;
		editorThinkingMedium?: ColorSpec;
		editorThinkingHigh?: ColorSpec;
		editorThinkingXhigh?: ColorSpec;
	};
	colorSources: ColorSourcesConfig;
	features: UiFeaturesConfig;
	footerSegments: FooterSegmentsConfig;
	gitCommit: GitCommitConfig;
	gitMetrics: GitMetricsConfig;
	extensionStatuses: ExtensionStatusesConfig;
	mouse: MouseConfig;
};

/**
 * Canonical footer format variable names. In a `footerFormat` string these
 * are written as `$name` or `${name}`.
 */
export const FOOTER_FORMAT_VARIABLES = [
	"model",
	"thinking",
	"cwd",
	"session_name",
	"git_branch",
	"git_status",
	"git_state",
	"runtime",
	"session_duration",
	"username",
	"os",
	"time",
	"context",
	"tokens",
	"cache_hit",
	"cost",
	"package",
	"package_version",
	"git_commit",
	"git_tag",
	"git_metrics",
	"git_added",
	"git_deleted",
	"sep",
] as const;

/**
 * Alias → canonical variable name mapping for `footerFormat`.
 * `$fill` is special (not a variable) and handled by the parser.
 */
export const FOOTER_FORMAT_ALIASES: Record<string, string> = {
	directory: "cwd",
	branch: "git_branch",
	status: "git_status",
	state: "git_state",
	commit: "git_commit",
	tag: "git_tag",
	duration: "session_duration",
	separator: "sep",
};

export const configPath = join(getAgentDir(), "starline.json");

export const defaultConfig: PolishedTuiConfig = {
	projectRefreshIntervalMs: DEFAULT_PROJECT_REFRESH_INTERVAL_MS,
	footerStyle: "text",
	pill: DEFAULT_PILL_CONFIG,
	footerFormat: "",
	editorMetadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
	separator: "pipe",
	contextStyle: "text",
	segmentOptions: { context: { format: "full" }, tokens: { cache: "percent" } },
	editorModelLabel: "id",
	editorCursor: "block",
	editorClickCursor: true,
	pasteCollapseLines: 11,
	editorPaddingY: 1,
	userMessagePaddingY: 1,
	contextThresholds: { warning: 70, error: 90 },
	pathDisplay: { mode: "basename", depth: 0 },
	gitBranch: { maxLength: "full" },
	gitHostIcon: false,
	icons: {
		mode: "auto",
		...NERD_DEFAULT_ICONS,
	},
	colors: {
		model: "bold blue",
		cwd: "bold cyan",
		sessionName: "bold green",
		gitBranch: "bold purple",
		gitStatus: "bold red",
		contextNormal: "bright-black",
		contextWarning: "bold yellow",
		contextError: "bold red",
		tokens: "bright-black",
		cacheHit: "bright-black",
		cost: "bold green",
		separator: "bright-black",
		runtimePrefix: "",
		extensionStatus: "bright-black",
		sessionDuration: "yellow",
		packageVersion: "208",
		gitCommit: "bold green",
		gitMetricsAdded: "bold green",
		gitMetricsDeleted: "bold red",
		username: "bold yellow",
		time: "bold yellow",
		os: "bold white",
	},
	colorSources: {
		starship: "theme",
		editor: "theme",
		userMessages: "theme",
	},
	features: {
		editor: true,
		statusLine: true,
		copyFriendly: false,
	},
	footerSegments: {
		model: false,
		thinking: false,
		cwd: true,
		sessionName: true,
		gitBranch: true,
		gitStatus: true,
		gitCounts: false,
		runtime: true,
		context: true,
		tokens: true,
		cacheHit: false,
		cost: true,
		sessionDuration: false,
		username: false,
		time: false,
		os: false,
		packageVersion: false,
		gitCommit: false,
		gitMetrics: false,
	},
	gitCommit: {
		hashLength: 7,
		onlyDetached: true,
		showTag: true,
	},
	gitMetrics: {
		onlyNonzero: true,
		ignoreSubmodules: false,
	},
	extensionStatuses: {
		defaultPlacement: "right",
		colors: {},
		icons: {},
		placements: {},
		colorModes: {},
	},
	mouse: {
		enabled: true,
		wheelRouting: true,
		copyNotice: true,
		copyOnSelect: true,
		clickToExpandTools: true,
		pathAwareWords: true,
		transcriptCleanCopy: true,
	},
};

type ConfigRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ConfigRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProjectRefreshIntervalMs(value: unknown): number {
	if (value === 0) return 0;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_PROJECT_REFRESH_INTERVAL_MS;
	}

	const interval = Math.round(value);
	if (interval <= 0) return 0;
	return Math.max(MIN_PROJECT_REFRESH_INTERVAL_MS, interval);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseContextStyle(value: unknown): ContextStyle {
	if (value === "text" || value === "gauge" || value === "text+gauge") return value;
	return defaultConfig.contextStyle;
}

function parseEditorModelLabel(value: unknown): ModelLabelSource {
	if (value === "id" || value === "name") return value;
	return defaultConfig.editorModelLabel;
}

export function isSeparatorStyle(value: unknown): value is SeparatorStyle {
	return value === "pipe" || value === "dot" || value === "chevron" || value === "none";
}

function parseSeparatorStyle(value: unknown): SeparatorStyle {
	return isSeparatorStyle(value) ? value : defaultConfig.separator;
}

function parseContextThresholds(value: unknown): ContextThresholds {
	const defaults = defaultConfig.contextThresholds;
	if (!isRecord(value)) return { ...defaults };

	const warningRaw = value.warning;
	const errorRaw = value.error;
	let warning =
		typeof warningRaw === "number" && Number.isFinite(warningRaw)
			? clampPercent(Math.round(warningRaw))
			: defaults.warning;
	let error =
		typeof errorRaw === "number" && Number.isFinite(errorRaw)
			? clampPercent(Math.round(errorRaw))
			: defaults.error;
	if (error < warning) {
		const swapped = warning;
		warning = error;
		error = swapped;
	}
	return { warning, error };
}

function parsePathDisplay(value: unknown): PathDisplayConfig {
	const defaults = defaultConfig.pathDisplay;
	if (!isRecord(value)) return { ...defaults };
	const mode = value.mode === "full" || value.mode === "basename" ? value.mode : defaults.mode;
	const rawDepth = value.depth;
	const depth =
		typeof rawDepth === "number" && Number.isFinite(rawDepth) && rawDepth >= 0
			? Math.min(5, Math.floor(rawDepth))
			: defaults.depth;
	return { mode, depth };
}

function normalizeGitBranchMaxLength(value: unknown): GitBranchMaxLength {
	if (value === "full") return value;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	return defaultConfig.gitBranch.maxLength;
}

function parseGitBranchConfig(value: unknown): GitBranchConfig {
	const defaults = defaultConfig.gitBranch;
	if (!isRecord(value)) return { ...defaults };
	return {
		maxLength: normalizeGitBranchMaxLength(value.maxLength),
	};
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function colorValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = stringValue(record, key);
	return value !== undefined && isSupportedColorSpec(value) ? value : undefined;
}

function colorSourceValue(
	record: Record<string, unknown>,
	key: keyof ColorSourcesConfig,
): ColorSource {
	const value = record[key];
	return value === "terminal" || value === "theme" ? value : defaultConfig.colorSources[key];
}

function booleanValue(record: Record<string, unknown>, key: keyof UiFeaturesConfig): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : defaultConfig.features[key];
}

function footerSegmentValue(
	record: Record<string, unknown>,
	key: keyof FooterSegmentsConfig,
): boolean {
	const value = record[key];
	return typeof value === "boolean" ? value : defaultConfig.footerSegments[key];
}

function definedColors(
	colors: Partial<Record<keyof PolishedTuiConfig["colors"], string | undefined>>,
): Partial<PolishedTuiConfig["colors"]> {
	return Object.fromEntries(
		Object.entries(colors).filter(
			(entry): entry is [keyof PolishedTuiConfig["colors"], string] => typeof entry[1] === "string",
		),
	) as Partial<PolishedTuiConfig["colors"]>;
}

function normalizeIconOverrides(record: Record<string, unknown>): Partial<IconGlyphs> {
	return Object.fromEntries(
		ICON_GLYPH_KEYS.flatMap((key) => {
			const value = stringValue(record, key);
			return value === undefined ? [] : [[key, value]];
		}),
	) as Partial<IconGlyphs>;
}

/**
 * A named colour palette, so a whole scheme can be restated in one place
 * instead of repeating hex values across every segment.
 *
 * Expansion is scoped to colour records only — `footerFormat` and
 * `editorMetadataFormat` use `$name` for their own format variables and must
 * never be touched by it.
 */
export type Palette = Record<string, string>;

const PALETTE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PALETTE_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_-]*)\}|\$([A-Za-z_][A-Za-z0-9_-]*)/g;
const PALETTE_MAX_DEPTH = 8;

export function normalizePalette(value: unknown): Palette {
	if (!isRecord(value)) return {};
	const palette: Palette = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry === "string" && PALETTE_NAME_PATTERN.test(name)) palette[name] = entry;
	}
	return palette;
}

function expandWithGuard(
	spec: string,
	palette: Palette,
	visiting: Set<string>,
	depth: number,
): string {
	if (depth > PALETTE_MAX_DEPTH || !spec.includes("$")) return spec;
	return spec.replace(PALETTE_REF_PATTERN, (match, braced?: string, bare?: string) => {
		const name = braced ?? bare;
		if (name === undefined) return match;
		const value = palette[name];
		// An unknown name, or one already being expanded further up the chain,
		// stays literal: it then fails isSupportedColorSpec and renders unstyled,
		// which surfaces the typo instead of silently resolving to nothing.
		if (value === undefined || visiting.has(name)) return match;
		visiting.add(name);
		const expanded = expandWithGuard(value, palette, visiting, depth + 1);
		visiting.delete(name);
		return expanded;
	});
}

/** Expand `$name` and `${name}` in a ColorSpec against the palette. */
export function expandPaletteRefs(spec: string, palette: Palette): string {
	return expandWithGuard(spec, palette, new Set(), 0);
}

/** Expand palette references in every string value of a colour record. */
export function expandPaletteInRecord(
	record: Record<string, unknown>,
	palette: Palette,
): Record<string, unknown> {
	if (Object.keys(palette).length === 0) return record;
	const expanded: Record<string, unknown> = { ...record };
	for (const [key, value] of Object.entries(record)) {
		if (typeof value === "string") expanded[key] = expandPaletteRefs(value, palette);
	}
	return expanded;
}

function normalizeColors(record: Record<string, unknown>): Partial<PolishedTuiConfig["colors"]> {
	return definedColors({
		model: colorValue(record, "model"),
		thinking: colorValue(record, "thinking"),
		cwd: colorValue(record, "cwd") ?? colorValue(record, "cwdText"),
		sessionName: colorValue(record, "sessionName"),
		gitBranch: colorValue(record, "gitBranch") ?? colorValue(record, "git"),
		gitStatus: colorValue(record, "gitStatus"),
		contextNormal: colorValue(record, "contextNormal"),
		contextWarning: colorValue(record, "contextWarning"),
		contextError: colorValue(record, "contextError"),
		tokens: colorValue(record, "tokens"),
		cacheHit: colorValue(record, "cacheHit"),
		cost: colorValue(record, "cost"),
		separator: colorValue(record, "separator"),
		runtimePrefix: colorValue(record, "runtimePrefix"),
		extensionStatus: colorValue(record, "extensionStatus"),
		sessionDuration: colorValue(record, "sessionDuration"),
		packageVersion: colorValue(record, "packageVersion"),
		gitCommit: colorValue(record, "gitCommit"),
		gitMetricsAdded: colorValue(record, "gitMetricsAdded"),
		gitMetricsDeleted: colorValue(record, "gitMetricsDeleted"),
		username: colorValue(record, "username"),
		time: colorValue(record, "time"),
		os: colorValue(record, "os"),
		userMessageBorder: colorValue(record, "userMessageBorder"),
		userMessageText: colorValue(record, "userMessageText"),
		editorAccent: colorValue(record, "editorAccent"),
		editorPrompt: colorValue(record, "editorPrompt"),
		editorBorder: colorValue(record, "editorBorder"),
		editorModel: colorValue(record, "editorModel"),
		editorProvider: colorValue(record, "editorProvider"),
		editorThinking: colorValue(record, "editorThinking"),
		editorThinkingMinimal: colorValue(record, "editorThinkingMinimal"),
		editorThinkingLow: colorValue(record, "editorThinkingLow"),
		editorThinkingMedium: colorValue(record, "editorThinkingMedium"),
		editorThinkingHigh: colorValue(record, "editorThinkingHigh"),
		editorThinkingXhigh: colorValue(record, "editorThinkingXhigh"),
	});
}

function normalizeColorSources(record: Record<string, unknown>): ColorSourcesConfig {
	return {
		starship: colorSourceValue(record, "starship"),
		editor: colorSourceValue(record, "editor"),
		userMessages: colorSourceValue(record, "userMessages"),
	};
}

function normalizeUiFeatures(record: Record<string, unknown>): UiFeaturesConfig {
	return {
		editor: booleanValue(record, "editor"),
		statusLine: booleanValue(record, "statusLine"),
		copyFriendly: booleanValue(record, "copyFriendly"),
	};
}

/**
 * Only 2..10 lowers the threshold; anything else — including Pi's own 11 — means
 * "leave Pi's behaviour alone".
 */
function parsePasteCollapseLines(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value)) return 11;
	return value >= 2 && value <= 10 ? value : 11;
}

/** Box padding is 0 or 1 rows; anything else falls back to the default. */
function parseBoxPadding(value: unknown, fallback: number): number {
	return value === 0 || value === 1 ? value : fallback;
}

function normalizeSegmentOptions(value: unknown): SegmentOptionsConfig {
	const record = isRecord(value) ? value : {};
	const context = isRecord(record.context) ? record.context : {};
	const tokens = isRecord(record.tokens) ? record.tokens : {};
	const cache = tokens.cache;
	return {
		context: { format: context.format === "percent" ? "percent" : "full" },
		tokens: {
			cache: cache === "tokens" || cache === "off" || cache === "percent" ? cache : "percent",
		},
	};
}

function normalizeFooterSegments(record: Record<string, unknown>): FooterSegmentsConfig {
	return {
		model: footerSegmentValue(record, "model"),
		thinking: footerSegmentValue(record, "thinking"),
		cwd: footerSegmentValue(record, "cwd"),
		sessionName: footerSegmentValue(record, "sessionName"),
		gitBranch: footerSegmentValue(record, "gitBranch"),
		gitStatus: footerSegmentValue(record, "gitStatus"),
		gitCounts: footerSegmentValue(record, "gitCounts"),
		runtime: footerSegmentValue(record, "runtime"),
		context: footerSegmentValue(record, "context"),
		tokens: footerSegmentValue(record, "tokens"),
		cacheHit: footerSegmentValue(record, "cacheHit"),
		cost: footerSegmentValue(record, "cost"),
		sessionDuration: footerSegmentValue(record, "sessionDuration"),
		username: footerSegmentValue(record, "username"),
		time: footerSegmentValue(record, "time"),
		os: footerSegmentValue(record, "os"),
		packageVersion: footerSegmentValue(record, "packageVersion"),
		gitCommit: footerSegmentValue(record, "gitCommit"),
		gitMetrics: footerSegmentValue(record, "gitMetrics"),
	};
}

/** Clamp hashLength to Git's valid abbreviation range [4, 40]. */
function normalizeGitHashLength(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return defaultConfig.gitCommit.hashLength;
	const rounded = Math.round(parsed);
	return Math.min(40, Math.max(4, rounded));
}

function normalizeGitCommitConfig(record: Record<string, unknown>): GitCommitConfig {
	return {
		hashLength: normalizeGitHashLength(record.hashLength),
		onlyDetached:
			typeof record.onlyDetached === "boolean"
				? record.onlyDetached
				: defaultConfig.gitCommit.onlyDetached,
		showTag: typeof record.showTag === "boolean" ? record.showTag : defaultConfig.gitCommit.showTag,
	};
}

function normalizeGitMetricsConfig(record: Record<string, unknown>): GitMetricsConfig {
	return {
		onlyNonzero:
			typeof record.onlyNonzero === "boolean"
				? record.onlyNonzero
				: defaultConfig.gitMetrics.onlyNonzero,
		ignoreSubmodules:
			typeof record.ignoreSubmodules === "boolean"
				? record.ignoreSubmodules
				: defaultConfig.gitMetrics.ignoreSubmodules,
	};
}

export function isExtensionStatusPlacement(value: unknown): value is ExtensionStatusPlacement {
	return value === "off" || value === "left" || value === "middle" || value === "right";
}

export function isExtensionStatusColorMode(value: unknown): value is ExtensionStatusColorMode {
	return value === "themed" || value === "original";
}

function normalizeExtensionStatuses(
	record: Record<string, unknown>,
	palette: Palette = {},
): ExtensionStatusesConfig {
	const defaultPlacement = isExtensionStatusPlacement(record.defaultPlacement)
		? record.defaultPlacement
		: defaultConfig.extensionStatuses.defaultPlacement;
	const placements = isRecord(record.placements)
		? Object.fromEntries(
				Object.entries(record.placements).filter(
					(entry): entry is [string, ExtensionStatusPlacement] =>
						isExtensionStatusPlacement(entry[1]),
				),
			)
		: {};
	const colorModes = isRecord(record.colorModes)
		? Object.fromEntries(
				Object.entries(record.colorModes).filter(
					(entry): entry is [string, ExtensionStatusColorMode] =>
						isExtensionStatusColorMode(entry[1]),
				),
			)
		: {};

	// Palette references have to be expanded before validation, or a $ref would
	// be rejected as an unsupported spec and silently drop the colour.
	const colors = isRecord(record.colors)
		? Object.fromEntries(
				Object.entries(expandPaletteInRecord(record.colors, palette)).filter(
					(entry): entry is [string, ColorSpec] =>
						typeof entry[1] === "string" && isSupportedColorSpec(entry[1]),
				),
			)
		: {};

	const icons = isRecord(record.icons)
		? Object.fromEntries(
				Object.entries(record.icons).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			)
		: {};

	return {
		defaultPlacement,
		placements,
		colorModes,
		colors,
		icons,
	};
}

function normalizeMouseConfig(record: Record<string, unknown>): MouseConfig {
	return {
		enabled: typeof record.enabled === "boolean" ? record.enabled : defaultConfig.mouse.enabled,
		wheelRouting:
			typeof record.wheelRouting === "boolean"
				? record.wheelRouting
				: defaultConfig.mouse.wheelRouting,
		copyNotice:
			typeof record.copyNotice === "boolean" ? record.copyNotice : defaultConfig.mouse.copyNotice,
		copyOnSelect:
			typeof record.copyOnSelect === "boolean"
				? record.copyOnSelect
				: defaultConfig.mouse.copyOnSelect,
		clickToExpandTools:
			typeof record.clickToExpandTools === "boolean"
				? record.clickToExpandTools
				: defaultConfig.mouse.clickToExpandTools,
		pathAwareWords:
			typeof record.pathAwareWords === "boolean"
				? record.pathAwareWords
				: defaultConfig.mouse.pathAwareWords,
		transcriptCleanCopy:
			typeof record.transcriptCleanCopy === "boolean"
				? record.transcriptCleanCopy
				: defaultConfig.mouse.transcriptCleanCopy,
	};
}

function isColorSourceKey(value: string): value is keyof ColorSourcesConfig {
	return value === "starship" || value === "editor" || value === "userMessages";
}

function isUiFeatureKey(value: string): value is keyof UiFeaturesConfig {
	return value === "editor" || value === "statusLine" || value === "copyFriendly";
}

function isFooterSegmentKey(value: string): value is keyof FooterSegmentsConfig {
	return (
		value === "cwd" ||
		value === "sessionName" ||
		value === "gitBranch" ||
		value === "gitStatus" ||
		value === "gitCounts" ||
		value === "runtime" ||
		value === "context" ||
		value === "tokens" ||
		value === "cost" ||
		value === "sessionDuration" ||
		value === "username" ||
		value === "time" ||
		value === "os" ||
		value === "packageVersion" ||
		value === "gitCommit" ||
		value === "gitMetrics"
	);
}

function validColorSourceEntries(record: Record<string, unknown>): Partial<ColorSourcesConfig> {
	return Object.fromEntries(
		Object.entries(record).filter((entry): entry is [keyof ColorSourcesConfig, ColorSource] => {
			const [key, value] = entry;
			return isColorSourceKey(key) && (value === "theme" || value === "terminal");
		}),
	) as Partial<ColorSourcesConfig>;
}

function validUiFeatureEntries(record: Record<string, unknown>): Partial<UiFeaturesConfig> {
	return Object.fromEntries(
		Object.entries(record).filter((entry): entry is [keyof UiFeaturesConfig, boolean] => {
			const [key, value] = entry;
			return isUiFeatureKey(key) && typeof value === "boolean";
		}),
	) as Partial<UiFeaturesConfig>;
}

function validFooterSegmentEntries(record: Record<string, unknown>): Partial<FooterSegmentsConfig> {
	return Object.fromEntries(
		Object.entries(record).filter((entry): entry is [keyof FooterSegmentsConfig, boolean] => {
			const [key, value] = entry;
			return isFooterSegmentKey(key) && typeof value === "boolean";
		}),
	) as Partial<FooterSegmentsConfig>;
}

type ConfigFileState =
	| { kind: "missing"; record: ConfigRecord; writePath: string }
	| { kind: "valid"; record: ConfigRecord; writePath: string; mode: number }
	| { kind: "corrupt"; error: unknown };

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

function readConfigFileState(path: string): ConfigFileState {
	let writePath = path;
	try {
		const pathStat = lstatSync(path);
		if (pathStat.isSymbolicLink()) writePath = realpathSync(path);
		const targetStat = statSync(writePath);
		const parsed = JSON.parse(readFileSync(writePath, "utf8"));
		return isRecord(parsed)
			? { kind: "valid", record: parsed, writePath, mode: targetStat.mode & 0o7777 }
			: { kind: "corrupt", error: new Error("top-level value must be a JSON object") };
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			try {
				lstatSync(path);
			} catch (pathError) {
				if (errorCode(pathError) === "ENOENT")
					return { kind: "missing", record: {}, writePath: path };
			}
		}
		return { kind: "corrupt", error };
	}
}

function writeConfigAtomically(path: string, record: ConfigRecord, mode?: number): void {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let file: number | undefined;
	try {
		file = openSync(tempPath, "wx", mode ?? 0o666);
		if (mode !== undefined) fchmodSync(file, mode);
		writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		renameSync(tempPath, path);
	} catch (error) {
		if (file !== undefined) {
			try {
				closeSync(file);
			} catch {}
		}
		try {
			unlinkSync(tempPath);
		} catch (cleanupError) {
			if (errorCode(cleanupError) !== "ENOENT") {
				// Preserve the persistence failure; the best-effort cleanup error is secondary.
			}
		}
		throw error;
	}
}

function mutateConfig(path: string, mutate: (record: ConfigRecord) => void): PolishedTuiConfig {
	const state = readConfigFileState(path);
	if (state.kind === "corrupt") {
		const detail = state.error instanceof Error ? ` (${state.error.message})` : "";
		throw new Error(
			`Refusing to save Starline config because ${path} is corrupt or unreadable; fix or remove it first.${detail}`,
		);
	}
	mutate(state.record);
	writeConfigAtomically(
		state.writePath,
		state.record,
		state.kind === "valid" ? state.mode : undefined,
	);
	return mergeConfig(state.record);
}

export function ensureConfigExists(): void {
	// Intentionally left as a no-op. Starline config is user-owned and
	// compatibility-sensitive: runtime defaults come from `mergeConfig({})`, and
	// the extension should not persist opinionated defaults unless the user
	// explicitly changes a setting.
}

export function mergeConfig(parsed: unknown): PolishedTuiConfig {
	const config = isRecord(parsed) ? parsed : {};
	const iconsRecord = isRecord(config.icons) ? (config.icons as Record<string, unknown>) : {};
	const iconMode = normalizeIconMode(iconsRecord.mode);
	const iconOverrides = normalizeIconOverrides(iconsRecord);
	const palette = normalizePalette(config.palette);
	const colors = isRecord(config.colors)
		? normalizeColors(expandPaletteInRecord(config.colors as Record<string, unknown>, palette))
		: {};
	const colorSources = isRecord(config.colorSources)
		? normalizeColorSources(config.colorSources as Record<string, unknown>)
		: defaultConfig.colorSources;
	const features = isRecord(config.features)
		? normalizeUiFeatures(config.features as Record<string, unknown>)
		: defaultConfig.features;
	const footerSegments = isRecord(config.footerSegments)
		? normalizeFooterSegments(config.footerSegments as Record<string, unknown>)
		: defaultConfig.footerSegments;
	const extensionStatuses = isRecord(config.extensionStatuses)
		? normalizeExtensionStatuses(config.extensionStatuses as Record<string, unknown>, palette)
		: defaultConfig.extensionStatuses;
	const gitCommit = isRecord(config.gitCommit)
		? normalizeGitCommitConfig(config.gitCommit as Record<string, unknown>)
		: defaultConfig.gitCommit;
	const gitMetrics = isRecord(config.gitMetrics)
		? normalizeGitMetricsConfig(config.gitMetrics as Record<string, unknown>)
		: defaultConfig.gitMetrics;
	const gitBranch = parseGitBranchConfig(config.gitBranch);
	const mouse = isRecord(config.mouse)
		? normalizeMouseConfig(config.mouse as Record<string, unknown>)
		: defaultConfig.mouse;
	const editorMetadataFormat = stringValue(config, "editorMetadataFormat");
	return {
		projectRefreshIntervalMs: parseProjectRefreshIntervalMs(config.projectRefreshIntervalMs),
		footerStyle: parseFooterStyle(config.footerStyle),
		pill: normalizePillConfig(config.pill),
		footerFormat: stringValue(config, "footerFormat") ?? "",
		// An explicit "" means "show nothing", which is how the model/thinking
		// segments get moved down to the footer without leaving an empty row.
		// Only a missing or non-string value falls back to the default.
		editorMetadataFormat: editorMetadataFormat ?? DEFAULT_EDITOR_METADATA_FORMAT,
		separator: parseSeparatorStyle(config.separator),
		contextStyle: parseContextStyle(config.contextStyle),
		segmentOptions: normalizeSegmentOptions(config.segmentOptions),
		editorModelLabel: parseEditorModelLabel(config.editorModelLabel),
		editorCursor: parseEditorCursorStyle(config.editorCursor),
		editorClickCursor: config.editorClickCursor !== false,
		pasteCollapseLines: parsePasteCollapseLines(config.pasteCollapseLines),
		editorPaddingY: parseBoxPadding(config.editorPaddingY, defaultConfig.editorPaddingY),
		userMessagePaddingY: parseBoxPadding(
			config.userMessagePaddingY,
			defaultConfig.userMessagePaddingY,
		),
		contextThresholds: parseContextThresholds(config.contextThresholds),
		pathDisplay: parsePathDisplay(config.pathDisplay),
		gitBranch,
		gitHostIcon: config.gitHostIcon === true,
		icons: resolveConfiguredIcons(iconMode, iconOverrides),
		colors: {
			...defaultConfig.colors,
			...colors,
		},
		colorSources: { ...colorSources },
		features: { ...features },
		footerSegments: { ...footerSegments },
		gitCommit,
		gitMetrics,
		extensionStatuses: {
			defaultPlacement: extensionStatuses.defaultPlacement,
			placements: { ...extensionStatuses.placements },
			colorModes: { ...extensionStatuses.colorModes },
			colors: { ...extensionStatuses.colors },
			icons: { ...extensionStatuses.icons },
		},
		mouse,
	};
}

export function getExtensionStatusPlacement(
	config: PolishedTuiConfig,
	key: string,
): ExtensionStatusPlacement {
	return config.extensionStatuses.placements[key] ?? config.extensionStatuses.defaultPlacement;
}

/** Colour for one status, or undefined to use the shared extensionStatus colour. */
export function getExtensionStatusColor(
	config: PolishedTuiConfig,
	key: string,
): ColorSpec | undefined {
	return config.extensionStatuses.colors[key];
}

/** Icon for one status, or "" when none is configured. */
export function getExtensionStatusIcon(config: PolishedTuiConfig, key: string): string {
	// Icons are a Nerd Font affordance; ascii mode drops them, as elsewhere.
	if (config.icons.mode === "ascii") return "";
	return config.extensionStatuses.icons[key] ?? "";
}

export function getExtensionStatusColorMode(
	config: PolishedTuiConfig,
	key: string,
): ExtensionStatusColorMode {
	return config.extensionStatuses.colorModes[key] ?? DEFAULT_EXTENSION_STATUS_COLOR_MODE;
}

export function loadConfig(): PolishedTuiConfig {
	try {
		if (!existsSync(configPath)) return mergeConfig({});
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		if (!isRecord(parsed)) return mergeConfig(parsed);

		const { config, migrated } = migrateFixedEditorKeys(parsed);
		if (migrated) {
			try {
				writeConfigAtomically(configPath, config);
			} catch {
				// Best effort: still use the migrated config for this run even if
				// the write-back fails (e.g. read-only filesystem).
			}
			console.warn(
				"[starline] Renamed your `fixedEditor` settings to `mouse` — the fixed editor is gone and Pi's own fullscreen mode replaces it. Your choices were kept.",
			);
		}
		return mergeConfig(config);
	} catch {
		return mergeConfig({});
	}
}

export function saveColorSourcesPatch(
	patch: Partial<ColorSourcesConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.colorSources)
			? { ...(record.colorSources as Record<string, unknown>) }
			: {};
		record.colorSources = {
			...existing,
			...validColorSourceEntries(patch),
		};
	});
}

export function saveUiFeaturesPatch(
	patch: Partial<UiFeaturesConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.features)
			? { ...(record.features as Record<string, unknown>) }
			: {};
		record.features = {
			...existing,
			...validUiFeatureEntries(patch),
		};
	});
}

export function saveFooterSegmentsPatch(
	patch: Partial<FooterSegmentsConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.footerSegments)
			? { ...(record.footerSegments as Record<string, unknown>) }
			: {};
		record.footerSegments = {
			...existing,
			...validFooterSegmentEntries(patch),
		};
	});
}

export function saveFooterFormatPatch(value: string, path = configPath): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		record.footerFormat = typeof value === "string" ? value : "";
	});
}

export function saveIconsModePatch(mode: IconMode, path = configPath): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.icons) ? { ...(record.icons as Record<string, unknown>) } : {};
		record.icons = {
			...existing,
			mode: normalizeIconMode(mode),
		};
	});
}

export function saveContextStylePatch(style: ContextStyle, path = configPath): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		record.contextStyle = parseContextStyle(style);
	});
}

export function saveSeparatorPatch(
	separator: SeparatorStyle,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		record.separator = parseSeparatorStyle(separator);
	});
}

export function saveContextThresholdsPatch(
	thresholds: Partial<ContextThresholds>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.contextThresholds)
			? { ...(record.contextThresholds as Record<string, unknown>) }
			: {};
		record.contextThresholds = {
			...existing,
			...thresholds,
		};
	});
}

export function savePathDisplayPatch(
	patch: Partial<PathDisplayConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.pathDisplay)
			? { ...(record.pathDisplay as Record<string, unknown>) }
			: {};
		if (patch.mode !== undefined) existing.mode = patch.mode;
		if (patch.depth !== undefined) existing.depth = patch.depth;
		record.pathDisplay = existing;
	});
}

export function saveGitBranchPatch(
	patch: Partial<GitBranchConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.gitBranch)
			? { ...(record.gitBranch as Record<string, unknown>) }
			: {};
		if (patch.maxLength !== undefined)
			existing.maxLength = normalizeGitBranchMaxLength(patch.maxLength);
		record.gitBranch = existing;
	});
}

export function saveExtensionStatusPlacement(
	key: string,
	placement: ExtensionStatusPlacement,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existingExtensionStatuses = isRecord(record.extensionStatuses)
			? { ...(record.extensionStatuses as Record<string, unknown>) }
			: {};
		const existingPlacements = isRecord(existingExtensionStatuses.placements)
			? { ...(existingExtensionStatuses.placements as Record<string, unknown>) }
			: {};

		Object.defineProperty(existingPlacements, key, {
			value: placement,
			enumerable: true,
			configurable: true,
			writable: true,
		});

		record.extensionStatuses = {
			...existingExtensionStatuses,
			placements: existingPlacements,
		};
	});
}

export function saveExtensionStatusColorMode(
	key: string,
	colorMode: ExtensionStatusColorMode,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existingExtensionStatuses = isRecord(record.extensionStatuses)
			? { ...(record.extensionStatuses as Record<string, unknown>) }
			: {};
		const existingColorModes = isRecord(existingExtensionStatuses.colorModes)
			? { ...(existingExtensionStatuses.colorModes as Record<string, unknown>) }
			: {};

		Object.defineProperty(existingColorModes, key, {
			value: colorMode,
			enumerable: true,
			configurable: true,
			writable: true,
		});

		record.extensionStatuses = {
			...existingExtensionStatuses,
			colorModes: existingColorModes,
		};
	});
}

export function saveMousePatch(patch: Partial<MouseConfig>, path = configPath): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.mouse) ? { ...(record.mouse as Record<string, unknown>) } : {};
		record.mouse = {
			...existing,
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			...(patch.wheelRouting !== undefined ? { wheelRouting: patch.wheelRouting } : {}),
			...(patch.copyNotice !== undefined ? { copyNotice: patch.copyNotice } : {}),
			...(patch.copyOnSelect !== undefined ? { copyOnSelect: patch.copyOnSelect } : {}),
			...(patch.clickToExpandTools !== undefined
				? { clickToExpandTools: patch.clickToExpandTools }
				: {}),
			...(patch.pathAwareWords !== undefined ? { pathAwareWords: patch.pathAwareWords } : {}),
			...(patch.transcriptCleanCopy !== undefined
				? { transcriptCleanCopy: patch.transcriptCleanCopy }
				: {}),
		};
	});
}
