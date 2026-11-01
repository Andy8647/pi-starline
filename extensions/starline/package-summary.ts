/**
 * What a release needs to know about this directory, and how the bubble that
 * answers it is drawn.
 *
 * The pill can only afford one figure, so it carries the manifest version and a
 * mark when that version is not what was released. Everything else is here: the
 * manifest it came from, the tag it is measured against, how far ahead of that
 * tag HEAD is, and — for a monorepo — which packages the repository publishes
 * and which of them moved since the tag.
 *
 * Nothing here is inferred. A version comes from a manifest, "released" from a
 * tag, "changed" from the diff between the two. A repository that publishes
 * nothing, or declares no version, shows that rather than a guess.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PillBubbleContent } from "../../types/pill-api";
import { readLatestTag, readTagDelta, type TagDelta } from "./git";
import { NERD_DEFAULT_ICONS } from "./icons";
import { type PackageVersionResult, readPackageVersion } from "./package-version";
import type { ThemeLike } from "./style";
import { readWorkspace, type WorkspaceInfo, type WorkspacePackage } from "./workspace";

export type PackageSummary = {
	/** The root manifest, when the directory has one with a version. */
	manifest?: PackageVersionResult;
	/** The name the manifest gives itself, else the directory's basename. */
	name?: string;
	/** `package.json#private`: nothing is published from here. */
	private?: boolean;
	/** The newest tag reachable from HEAD. */
	tag?: string;
	/** How far HEAD is past that tag, and what moved on the way. */
	delta?: TagDelta;
	/** The workspace this directory declares, if it declares one. */
	workspace?: WorkspaceInfo;
};

export type PackageSummaryReaders = {
	readManifest: typeof readPackageVersion;
	readLatestTag: typeof readLatestTag;
	readTagDelta: typeof readTagDelta;
	readWorkspace: typeof readWorkspace;
};

const REAL_READERS: PackageSummaryReaders = {
	readManifest: readPackageVersion,
	readLatestTag,
	readTagDelta,
	readWorkspace,
};

/** Starship's ecosystem keys are its own; these are the names people use. */
const ECOSYSTEM_LABELS: Record<string, string> = {
	nodejs: "npm",
	rust: "cargo",
	php: "composer",
	dart: "pub",
	elixir: "mix",
	haskell: "cabal",
};

function ecosystemLabel(ecosystem: string): string {
	return ECOSYSTEM_LABELS[ecosystem] ?? ecosystem;
}

/** `name` and `private` from a `package.json`, without the version machinery. */
function readRootPackageJson(cwd: string): { name?: string; private?: boolean } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		const record = parsed as { name?: unknown; private?: unknown };
		return {
			name: typeof record.name === "string" && record.name ? record.name : undefined,
			private: record.private === true ? true : undefined,
		};
	} catch {
		return {};
	}
}

function basename(path: string): string {
	const stripped = path.replace(/\/+$/, "");
	return stripped.slice(stripped.lastIndexOf("/") + 1);
}

/**
 * Read everything the bubble draws.
 *
 * The tag is read first because the delta needs it; the manifest and the
 * workspace are local file reads and run beside it. Two git processes, both
 * only when the bubble is opened.
 */
export async function readPackageSummary(
	cwd: string,
	readers: PackageSummaryReaders = REAL_READERS,
): Promise<PackageSummary> {
	const [tag, manifest, workspace] = await Promise.all([
		readers.readLatestTag(cwd),
		Promise.resolve(readers.readManifest(cwd) ?? undefined),
		Promise.resolve(readers.readWorkspace(cwd)),
	]);
	const delta = tag ? await readers.readTagDelta(cwd, tag) : undefined;
	const root = readRootPackageJson(cwd);
	return {
		manifest,
		name: root.name ?? basename(cwd),
		private: root.private,
		tag,
		delta,
		workspace,
	};
}

/** Paints nothing: for callers that only need the text. */
const NO_THEME: ThemeLike = { fg: (_color, text) => text };

function paint(theme: ThemeLike, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		// An unknown token throws in pi's theme; drop the colour, keep the text.
		return text;
	}
}

/** Wide enough for `@scope/name`, short of crowding the row. */
const NAME_COLUMNS = 24;
/**
 * How many package rows the bubble draws.
 *
 * A workspace can hold fifty packages; a bubble is a popover, not a table, and a
 * list taller than the terminal scrolls the pill off the screen. The rows that
 * are cut are counted out loud rather than silently dropped.
 */
const MAX_ROWS = 15;

function fitColumn(text: string, width: number): string {
	return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

/**
 * The scope most of these packages come from, when one of them owns the list.
 *
 * A workspace whose rows all begin with `@acme/` says nothing with that column:
 * the names are the part that differs. A majority is enough — a few packages
 * outside the scope keep their own prefix and stay distinguishable.
 */
function sharedScope(names: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const name of names) {
		const cut = name.indexOf("/");
		if (cut <= 0) continue;
		const scope = name.slice(0, cut + 1);
		counts.set(scope, (counts.get(scope) ?? 0) + 1);
	}
	let best: string | undefined;
	for (const [scope, count] of counts) {
		if (count * 2 <= names.length) continue;
		if (best === undefined || count > (counts.get(best) ?? 0)) best = scope;
	}
	return best;
}

/** The packages the diff touched, by directory. */
export function changedPackageDirs(
	paths: readonly string[],
	packages: readonly WorkspacePackage[],
): Set<string> {
	const changed = new Set<string>();
	for (const pkg of packages) {
		if (paths.some((path) => path === pkg.dir || path.startsWith(`${pkg.dir}/`))) {
			changed.add(pkg.dir);
		}
	}
	return changed;
}

/** One row per package: name, version, and whether it moved since the tag. */
function packageRows(workspace: WorkspaceInfo, summary: PackageSummary): string[] {
	const packages = workspace.packages;
	if (packages.length === 0) {
		return ["no package matched the workspace globs"];
	}
	const changed = summary.delta ? changedPackageDirs(summary.delta.paths, packages) : undefined;
	const scope = sharedScope(packages.map((pkg) => pkg.name));
	const versionWidth = Math.min(
		12,
		packages.reduce((widest, pkg) => Math.max(widest, pkg.version?.length ?? 1), 1),
	);
	const rows = packages.slice(0, MAX_ROWS).map((pkg) => {
		const name = scope && pkg.name.startsWith(scope) ? pkg.name.slice(scope.length) : pkg.name;
		const version = (pkg.version ?? "--").padEnd(versionWidth);
		const marks: string[] = [];
		if (changed?.has(pkg.dir)) marks.push("changed");
		if (pkg.private) marks.push("private");
		return `${fitColumn(name, NAME_COLUMNS)} ${version}${marks.length > 0 ? `  ${marks.join(" · ")}` : ""}`;
	});
	if (packages.length > rows.length) rows.push(`… ${packages.length - rows.length} more`);
	return rows;
}

/**
 * The bubble's body lines, one fact per line.
 *
 * Every row fits a single line: the bubble wraps what it is given, and a
 * package list that wraps is a list you have to read twice to count.
 */
export function packageBubbleContent(
	summary: PackageSummary,
	theme: ThemeLike = NO_THEME,
): PillBubbleContent {
	const version = summary.manifest?.version;
	const name = summary.name;
	const title = [version, name].filter(Boolean).join(" · ") || "Package";

	const body: string[] = [];
	if (summary.manifest) {
		const name = ecosystemLabel(summary.manifest.ecosystem);
		const publishable = summary.private === true ? "private" : "public";
		body.push(
			`${NERD_DEFAULT_ICONS.package} ${paint(theme, "accent", name)} ${paint(
				theme,
				"dim",
				`${publishable} · ${summary.manifest.file}`,
			)}`,
		);
	}

	if (summary.tag) {
		const ahead = summary.delta?.commits ?? 0;
		const state = ahead === 0 ? "tag is HEAD" : `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
		body.push(`󰓹 ${paint(theme, "muted", summary.tag)} ${paint(theme, "dim", `· ${state}`)}`);
	}

	if (summary.workspace) {
		const count = summary.workspace.packages.length;
		body.push(
			`${paint(theme, "accent", summary.workspace.manager)} ${paint(
				theme,
				"dim",
				`workspace · ${count} package${count === 1 ? "" : "s"}`,
			)}`,
		);
		for (const row of packageRows(summary.workspace, summary)) body.push(`  ${row}`);
	}

	if (body.length === 0) body.push("No package manifest in this directory.");
	return { title, body, hint: "esc closes" };
}
