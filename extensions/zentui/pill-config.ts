/**
 * Configuration for the pill footer style.
 *
 * The pill bar is a second rendering of the footer, not a second footer: it
 * draws the same segments as coloured blocks joined by seamless arrows instead
 * of as coloured text. `footerStyle: "text"` keeps `footerFormat` and upstream
 * behaviour exactly; `footerStyle: "pill"` ignores `footerFormat` and lays the
 * bar out from `pill.segments`.
 */

export type FooterStyle = "text" | "pill";

/** Glyph drawn between two pills. */
export type PillSeparator = "powerline" | "powerline-thin" | "none";

/** How the two ends of the bar are closed off. */
export type PillCaps = "round" | "right" | "none";

export type PillConfig = {
	/**
	 * Ordered segments, left to right. Names are `footerSegments` keys, plus
	 * `extensionStatus` for every status not already listed and
	 * `extensionStatus:<key>` to place one specific status.
	 */
	segments: string[];
	separator: PillSeparator;
	bold: boolean;
	caps: PillCaps;
};

export const EXTENSION_STATUS_SEGMENT = "extensionStatus";
export const EXTENSION_STATUS_PREFIX = `${EXTENSION_STATUS_SEGMENT}:`;

/** Segment names that map onto a footer variable. */
export const PILL_SEGMENT_VARIABLES: Record<string, string> = {
	model: "model",
	thinking: "thinking",
	cwd: "cwd",
	sessionName: "session_name",
	gitBranch: "git_branch",
	gitStatus: "git_status",
	gitState: "git_state",
	gitCommit: "git_commit",
	gitTag: "git_tag",
	gitMetrics: "git_metrics",
	runtime: "runtime",
	context: "context",
	tokens: "tokens",
	cacheHit: "cache_hit",
	cost: "cost",
	sessionDuration: "session_duration",
	username: "username",
	time: "time",
	os: "os",
	packageVersion: "package_version",
};

export const DEFAULT_PILL_CONFIG: PillConfig = {
	segments: [
		"model",
		"thinking",
		"cwd",
		"gitBranch",
		"gitStatus",
		"context",
		"cost",
		EXTENSION_STATUS_SEGMENT,
	],
	separator: "powerline",
	bold: true,
	caps: "round",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFooterStyle(value: unknown): FooterStyle {
	return value === "pill" ? "pill" : "text";
}

function parseSeparator(value: unknown): PillSeparator {
	return value === "powerline-thin" || value === "none" || value === "powerline"
		? value
		: DEFAULT_PILL_CONFIG.separator;
}

function parseCaps(value: unknown): PillCaps {
	return value === "right" || value === "none" || value === "round"
		? value
		: DEFAULT_PILL_CONFIG.caps;
}

/** A segment name is usable if it maps to a variable or addresses a status. */
export function isKnownPillSegment(name: string): boolean {
	if (name === EXTENSION_STATUS_SEGMENT) return true;
	if (name.startsWith(EXTENSION_STATUS_PREFIX)) return name.length > EXTENSION_STATUS_PREFIX.length;
	return name in PILL_SEGMENT_VARIABLES;
}

function parseSegments(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_PILL_CONFIG.segments;
	const segments: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const name = entry.trim();
		// Unknown names are dropped rather than rendered as empty pills, so a
		// typo shortens the bar instead of punching a hole in it.
		if (name && isKnownPillSegment(name) && !segments.includes(name)) segments.push(name);
	}
	return segments;
}

export function normalizePillConfig(value: unknown): PillConfig {
	if (!isRecord(value)) return { ...DEFAULT_PILL_CONFIG };
	return {
		segments: parseSegments(value.segments),
		separator: parseSeparator(value.separator),
		bold: typeof value.bold === "boolean" ? value.bold : DEFAULT_PILL_CONFIG.bold,
		caps: parseCaps(value.caps),
	};
}
