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
import { DEFAULT_PILL_CONFIG, normalizePillConfig, type PillConfig } from "./pill-config";
import { isSupportedColorSpec } from "./style";

export type ColorSpec = string;
export type ColorSource = "theme" | "terminal";
export type { IconMode } from "./icons";

export type ContextStyle = "text" | "gauge" | "text+gauge";
/** How much the context segment spells out. Orthogonal to ContextStyle. */
export type ContextFormat = "full" | "percent";
/** What the tokens segment shows for cache activity. */
export type TokensCacheFormat = "percent" | "tokens" | "off";
/** What the subagents segment spells out: `2 agents`, or just the count. */
export type SubagentsFormat = "agents" | "count";

export type SegmentOptionsConfig = {
	context: { format: ContextFormat };
	tokens: { cache: TokensCacheFormat };
	subagents: { format: SubagentsFormat };
};
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
};

export type UiFeaturesConfig = {
	editor: boolean;
	statusLine: boolean;
	copyFriendly: boolean;
};

export type GitConfig = {
	/** Glyphs carry their number (`!3`) instead of standing alone (`!`). */
	counts: boolean;
	/** Use the origin remote's forge logo as the branch icon. */
	hostIcon: boolean;
	branch: GitBranchConfig;
	commit: GitCommitConfig;
	metrics: GitMetricsConfig;
};

export type MouseConfig = {
	enabled: boolean;
	wheelRouting: boolean;
	/** Show a "copied to clipboard" notice for a copy Starline itself performs. */
	copyNotice: boolean;
	/** Copy transcript selections without the painted rails, rules and frames. */
	transcriptCleanCopy: boolean;
};

const FIXED_EDITOR_KEY_MAP: Record<string, keyof MouseConfig> = {
	enabled: "enabled",
	mouseScroll: "wheelRouting",
	copyNotice: "copyNotice",
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

/**
 * Where in the footer a third-party status is drawn, or `off`. Up to 0.8 there
 * was also `editor`, the editor's metadata row; see `readExtensionStatusPlacement`.
 */
export type ExtensionStatusPlacement = "off" | "left" | "middle" | "right";
export type ExtensionStatusColorMode = "themed" | "original";
/**
 * How much of a status is drawn: its text as published, or just its number.
 * "value" is for statuses whose words are redundant once the pill has an icon.
 */
export type ExtensionStatusFormat = "full" | "value";

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
	/**
	 * Per-status text shape, keyed by status key. `"value"` keeps only the number
	 * (`Tavily: 41.1%` → `41.1%`), so an icon plus that number reads as one pill;
	 * a status with no number keeps its text. Defaults to the published text.
	 */
	formats: Record<string, ExtensionStatusFormat>;
};

const DEFAULT_PROJECT_REFRESH_INTERVAL_MS = 30_000;
const MIN_PROJECT_REFRESH_INTERVAL_MS = 5_000;

export type PolishedTuiConfig = {
	projectRefreshIntervalMs: number;
	pill: PillConfig;
	contextStyle: ContextStyle;
	segmentOptions: SegmentOptionsConfig;
	editorModelLabel: ModelLabelSource;
	editorCursor: EditorCursorStyle;
	/** Clicking in the editor text moves the caret there. Needs `mouse.enabled`. */
	editorClickCursor: boolean;
	/** Collapse pastes at this many lines. 11 (default) leaves Pi's threshold alone. */
	pasteCollapseLines: number;
	/** Blank rows inside the editor box, above and below the input. */
	editorPaddingY: number;
	/** The input area's height floor: a shorter draft is followed by blank rows. */
	editorMinRows: number;
	contextThresholds: ContextThresholds;
	pathDisplay: PathDisplayConfig;
	git: GitConfig;
	icons: ResolvedIcons;
	colors: {
		model: ColorSpec;
		/** Unset derives the colour from the level via the theme's thinking* keys. */
		thinking?: ColorSpec;
		/** The queued-messages pill, which only exists while something is queued. */
		queue: ColorSpec;
		/** The running-subagents pill, which only exists while pi-subagents runs something. */
		subagents: ColorSpec;
		cwd: ColorSpec;
		sessionName: ColorSpec;
		gitBranch: ColorSpec;
		contextNormal: ColorSpec;
		contextWarning: ColorSpec;
		contextError: ColorSpec;
		cost: ColorSpec;
		/** Decode throughput of the latest assistant message. */
		tps: ColorSpec;
		runtimePrefix: ColorSpec;
		extensionStatus: ColorSpec;
		sessionDuration: ColorSpec;
		packageVersion: ColorSpec;
		gitCommit: ColorSpec;
		gitMetricsAdded: ColorSpec;
		username: ColorSpec;
		time: ColorSpec;
		os: ColorSpec;
		editorAccent?: ColorSpec;
		editorPrompt?: ColorSpec;
		editorBorder?: ColorSpec;
	};
	colorSources: ColorSourcesConfig;
	features: UiFeaturesConfig;
	extensionStatuses: ExtensionStatusesConfig;
	mouse: MouseConfig;
};

export const configPath = join(getAgentDir(), "starline.json");

export const defaultConfig: PolishedTuiConfig = {
	projectRefreshIntervalMs: DEFAULT_PROJECT_REFRESH_INTERVAL_MS,
	pill: DEFAULT_PILL_CONFIG,
	contextStyle: "text",
	segmentOptions: {
		context: { format: "full" },
		tokens: { cache: "percent" },
		subagents: { format: "agents" },
	},
	editorModelLabel: "id",
	editorCursor: "block",
	editorClickCursor: true,
	pasteCollapseLines: 11,
	editorPaddingY: 1,
	editorMinRows: 1,
	contextThresholds: { warning: 70, error: 90 },
	pathDisplay: { mode: "basename", depth: 0 },
	git: {
		counts: false,
		hostIcon: false,
		branch: { maxLength: "full" },
		commit: { hashLength: 7, onlyDetached: true, showTag: true },
		metrics: { onlyNonzero: true, ignoreSubmodules: false },
	},
	icons: {
		mode: "auto",
		...NERD_DEFAULT_ICONS,
	},
	colors: {
		model: "bold blue",
		queue: "bold yellow",
		subagents: "bold green",
		cwd: "bold cyan",
		sessionName: "bold green",
		gitBranch: "bold purple",
		contextNormal: "bright-black",
		contextWarning: "bold yellow",
		contextError: "bold red",
		cost: "bold green",
		tps: "bright-black",
		runtimePrefix: "",
		extensionStatus: "bright-black",
		sessionDuration: "yellow",
		packageVersion: "208",
		gitCommit: "bold green",
		gitMetricsAdded: "bold green",
		username: "bold yellow",
		time: "bold yellow",
		os: "bold white",
	},
	colorSources: {
		starship: "theme",
		editor: "theme",
	},
	features: {
		editor: true,
		statusLine: true,
		copyFriendly: false,
	},
	extensionStatuses: {
		defaultPlacement: "right",
		colors: {},
		icons: {},
		placements: {},
		colorModes: {},
		formats: {},
	},
	mouse: {
		enabled: true,
		wheelRouting: true,
		copyNotice: true,
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
	return defaultConfig.git.branch.maxLength;
}

function parseGitConfig(value: unknown): GitConfig {
	const defaults = defaultConfig.git;
	if (!isRecord(value)) return structuredClone(defaults);
	const branch = isRecord(value.branch) ? value.branch : {};
	const commit = isRecord(value.commit) ? value.commit : {};
	const metrics = isRecord(value.metrics) ? value.metrics : {};
	return {
		counts: typeof value.counts === "boolean" ? value.counts : defaults.counts,
		hostIcon: typeof value.hostIcon === "boolean" ? value.hostIcon : defaults.hostIcon,
		branch: { maxLength: normalizeGitBranchMaxLength(branch.maxLength) },
		commit: normalizeGitCommitConfig(commit),
		metrics: normalizeGitMetricsConfig(metrics),
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
 * Expansion is scoped to colour records only — keys and other strings are
 * never touched by it.
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
		queue: colorValue(record, "queue"),
		subagents: colorValue(record, "subagents"),
		cwd: colorValue(record, "cwd") ?? colorValue(record, "cwdText"),
		sessionName: colorValue(record, "sessionName"),
		gitBranch: colorValue(record, "gitBranch") ?? colorValue(record, "git"),
		contextNormal: colorValue(record, "contextNormal"),
		contextWarning: colorValue(record, "contextWarning"),
		contextError: colorValue(record, "contextError"),
		cost: colorValue(record, "cost"),
		tps: colorValue(record, "tps"),
		runtimePrefix: colorValue(record, "runtimePrefix"),
		extensionStatus: colorValue(record, "extensionStatus"),
		sessionDuration: colorValue(record, "sessionDuration"),
		packageVersion: colorValue(record, "packageVersion"),
		gitCommit: colorValue(record, "gitCommit"),
		gitMetricsAdded: colorValue(record, "gitMetricsAdded"),
		username: colorValue(record, "username"),
		time: colorValue(record, "time"),
		os: colorValue(record, "os"),
		editorAccent: colorValue(record, "editorAccent"),
		editorPrompt: colorValue(record, "editorPrompt"),
		editorBorder: colorValue(record, "editorBorder"),
	});
}

function normalizeColorSources(record: Record<string, unknown>): ColorSourcesConfig {
	return {
		starship: colorSourceValue(record, "starship"),
		editor: colorSourceValue(record, "editor"),
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

const MAX_EDITOR_MIN_ROWS = 10;

function parseEditorMinRows(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return defaultConfig.editorMinRows;
	}
	return Math.min(MAX_EDITOR_MIN_ROWS, value);
}

function normalizeSegmentOptions(value: unknown): SegmentOptionsConfig {
	const record = isRecord(value) ? value : {};
	const context = isRecord(record.context) ? record.context : {};
	const tokens = isRecord(record.tokens) ? record.tokens : {};
	const subagents = isRecord(record.subagents) ? record.subagents : {};
	const cache = tokens.cache;
	return {
		context: { format: context.format === "percent" ? "percent" : "full" },
		tokens: {
			cache: cache === "tokens" || cache === "off" || cache === "percent" ? cache : "percent",
		},
		subagents: { format: subagents.format === "count" ? "count" : "agents" },
	};
}

/** Clamp hashLength to Git's valid abbreviation range [4, 40]. */
function normalizeGitHashLength(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return defaultConfig.git.commit.hashLength;
	const rounded = Math.round(parsed);
	return Math.min(40, Math.max(4, rounded));
}

function normalizeGitCommitConfig(record: Record<string, unknown>): GitCommitConfig {
	return {
		hashLength: normalizeGitHashLength(record.hashLength),
		onlyDetached:
			typeof record.onlyDetached === "boolean"
				? record.onlyDetached
				: defaultConfig.git.commit.onlyDetached,
		showTag:
			typeof record.showTag === "boolean" ? record.showTag : defaultConfig.git.commit.showTag,
	};
}

function normalizeGitMetricsConfig(record: Record<string, unknown>): GitMetricsConfig {
	return {
		onlyNonzero:
			typeof record.onlyNonzero === "boolean"
				? record.onlyNonzero
				: defaultConfig.git.metrics.onlyNonzero,
		ignoreSubmodules:
			typeof record.ignoreSubmodules === "boolean"
				? record.ignoreSubmodules
				: defaultConfig.git.metrics.ignoreSubmodules,
	};
}

export function isExtensionStatusPlacement(value: unknown): value is ExtensionStatusPlacement {
	return value === "off" || value === "left" || value === "middle" || value === "right";
}

/**
 * A stored placement, read leniently: `editor` named the editor's metadata row,
 * which 0.9 removed, so those statuses move to the right of the footer rather
 * than disappearing.
 */
function readExtensionStatusPlacement(value: unknown): ExtensionStatusPlacement | undefined {
	if (value === "editor") return "right";
	return isExtensionStatusPlacement(value) ? value : undefined;
}

export function isExtensionStatusColorMode(value: unknown): value is ExtensionStatusColorMode {
	return value === "themed" || value === "original";
}

function normalizeExtensionStatuses(
	record: Record<string, unknown>,
	palette: Palette = {},
): ExtensionStatusesConfig {
	const defaultPlacement =
		readExtensionStatusPlacement(record.defaultPlacement) ??
		defaultConfig.extensionStatuses.defaultPlacement;
	const placements = isRecord(record.placements)
		? Object.fromEntries(
				Object.entries(record.placements).flatMap(([key, value]) => {
					const placement = readExtensionStatusPlacement(value);
					return placement ? [[key, placement]] : [];
				}),
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

	const formats = isRecord(record.formats)
		? Object.fromEntries(
				Object.entries(record.formats).filter(
					(entry): entry is [string, ExtensionStatusFormat] =>
						entry[1] === "full" || entry[1] === "value",
				),
			)
		: {};

	return {
		defaultPlacement,
		placements,
		colorModes,
		colors,
		icons,
		formats,
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
		transcriptCleanCopy:
			typeof record.transcriptCleanCopy === "boolean"
				? record.transcriptCleanCopy
				: defaultConfig.mouse.transcriptCleanCopy,
	};
}

function isColorSourceKey(value: string): value is keyof ColorSourcesConfig {
	return value === "starship" || value === "editor";
}

function isUiFeatureKey(value: string): value is keyof UiFeaturesConfig {
	return value === "editor" || value === "statusLine" || value === "copyFriendly";
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
	const extensionStatuses = isRecord(config.extensionStatuses)
		? normalizeExtensionStatuses(config.extensionStatuses as Record<string, unknown>, palette)
		: defaultConfig.extensionStatuses;
	const git = parseGitConfig(config.git);
	const mouse = isRecord(config.mouse)
		? normalizeMouseConfig(config.mouse as Record<string, unknown>)
		: defaultConfig.mouse;
	return {
		projectRefreshIntervalMs: parseProjectRefreshIntervalMs(config.projectRefreshIntervalMs),
		pill: normalizePillConfig(config.pill),
		contextStyle: parseContextStyle(config.contextStyle),
		segmentOptions: normalizeSegmentOptions(config.segmentOptions),
		editorModelLabel: parseEditorModelLabel(config.editorModelLabel),
		editorCursor: parseEditorCursorStyle(config.editorCursor),
		editorClickCursor: config.editorClickCursor !== false,
		pasteCollapseLines: parsePasteCollapseLines(config.pasteCollapseLines),
		editorPaddingY: parseBoxPadding(config.editorPaddingY, defaultConfig.editorPaddingY),
		editorMinRows: parseEditorMinRows(config.editorMinRows),
		contextThresholds: parseContextThresholds(config.contextThresholds),
		pathDisplay: parsePathDisplay(config.pathDisplay),
		git,
		icons: resolveConfiguredIcons(iconMode, iconOverrides),
		colors: {
			...defaultConfig.colors,
			...colors,
		},
		colorSources: { ...colorSources },
		features: { ...features },
		extensionStatuses: {
			defaultPlacement: extensionStatuses.defaultPlacement,
			placements: { ...extensionStatuses.placements },
			colorModes: { ...extensionStatuses.colorModes },
			colors: { ...extensionStatuses.colors },
			icons: { ...extensionStatuses.icons },
			formats: { ...extensionStatuses.formats },
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

/** Text shape for one status. Unset means the text the extension published. */
export function getExtensionStatusFormat(
	config: PolishedTuiConfig,
	key: string,
): ExtensionStatusFormat {
	return config.extensionStatuses.formats[key] ?? "full";
}

export function getExtensionStatusColorMode(
	config: PolishedTuiConfig,
	key: string,
): ExtensionStatusColorMode {
	return config.extensionStatuses.colorModes[key] ?? DEFAULT_EXTENSION_STATUS_COLOR_MODE;
}

let warnedMovedUserMessageKeys = false;

/**
 * User message styling moved to pi-tidy in 0.9. Its keys are ignored here; say
 * so once per process rather than letting a setting stop working in silence.
 */
function warnMovedUserMessageKeys(record: Record<string, unknown>): void {
	if (warnedMovedUserMessageKeys) return;
	const colors = isRecord(record.colors) ? record.colors : {};
	const colorSources = isRecord(record.colorSources) ? record.colorSources : {};
	const moved = [
		"userMessagePaddingY" in record && "userMessagePaddingY",
		"userMessageBorder" in colors && "colors.userMessageBorder",
		"userMessageText" in colors && "colors.userMessageText",
		"userMessages" in colorSources && "colorSources.userMessages",
	].filter((key): key is string => Boolean(key));
	if (moved.length === 0) return;
	warnedMovedUserMessageKeys = true;
	console.warn(
		`[starline] User messages are styled by pi-tidy now (its userMessageStyle, userMessagePaddingY and userMessageColors settings); ignoring ${moved.join(", ")}.`,
	);
}

export function loadConfig(path = configPath): PolishedTuiConfig {
	try {
		if (!existsSync(path)) return mergeConfig({});
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return mergeConfig(parsed);

		const { config, migrated } = migrateFixedEditorKeys(parsed);
		if (migrated) {
			try {
				writeConfigAtomically(path, config);
			} catch {
				// Best effort: still use the migrated config for this run even if
				// the write-back fails (e.g. read-only filesystem).
			}
			console.warn(
				"[starline] Renamed your `fixedEditor` settings to `mouse` — the fixed editor is gone and Pi's own fullscreen mode replaces it. Your choices were kept.",
			);
		}
		warnMovedUserMessageKeys(config);
		return mergeConfig(config);
	} catch (error) {
		// Falling back to defaults is right — a broken config must not block a
		// session — but silently forgetting every setting is not. `mutateConfig`
		// refuses loudly on the same file, so say which file was given up on.
		console.warn(
			`[starline] Could not read ${path}; using defaults for this session. ${error instanceof Error ? error.message : String(error)}`,
		);
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

export function savePillSegmentsPatch(
	segments: readonly string[],
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existing = isRecord(record.pill) ? { ...(record.pill as Record<string, unknown>) } : {};
		record.pill = { ...existing, segments: [...segments] };
	});
}

export function saveGitBranchPatch(
	patch: Partial<GitBranchConfig>,
	path = configPath,
): PolishedTuiConfig {
	return mutateConfig(path, (record) => {
		const existingGit = isRecord(record.git) ? { ...(record.git as Record<string, unknown>) } : {};
		const existingBranch = isRecord(existingGit.branch)
			? { ...(existingGit.branch as Record<string, unknown>) }
			: {};
		if (patch.maxLength !== undefined)
			existingBranch.maxLength = normalizeGitBranchMaxLength(patch.maxLength);
		record.git = { ...existingGit, branch: existingBranch };
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
			...(patch.transcriptCleanCopy !== undefined
				? { transcriptCleanCopy: patch.transcriptCleanCopy }
				: {}),
		};
	});
}
