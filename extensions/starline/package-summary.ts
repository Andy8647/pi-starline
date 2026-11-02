/**
 * What a release needs to know about this directory, and how the bubble that
 * answers it is drawn.
 *
 * The pill can only afford one figure, so it carries the manifest version and a
 * mark when that version is not what was released. Everything else is here: every
 * manifest the directory holds (a pnpm root with a Python service beside it has
 * two), the tag the version is measured against, how far ahead of that tag HEAD
 * is, and — for a monorepo — which packages the repository holds and which of
 * them moved since the tag.
 *
 * Nothing here is inferred. A version comes from a manifest, "released" from a
 * tag, "changed" from the diff between the two. A repository that publishes
 * nothing, or declares no version, shows that rather than a guess.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PillBubbleContent, PillBubbleLine } from "../../types/pill-api";
import { readLatestTag, readTagDelta, type TagDelta } from "./git";
import { NERD_DEFAULT_ICONS } from "./icons";
import { openExternalUrl } from "./open-url";
import { type RootManifest, readRootManifests } from "./package-version";
import type { ThemeLike } from "./style";
import {
	readLoosePackages,
	readWorkspace,
	type WorkspaceInfo,
	type WorkspacePackage,
} from "./workspace";

export type PackageSummary = {
	/** Every manifest in the directory, in parser order; the first with a version wins. */
	manifests: RootManifest[];
	/** The name the manifest gives itself, else the directory's basename. */
	name?: string;
	/** `package.json#private`: nothing is published from here. */
	private?: boolean;
	/** What the registry reports, when this is a package the registry knows. */
	published?: PublishedPackage;
	/** The newest tag reachable from HEAD. */
	tag?: string;
	/** How far HEAD is past that tag, and what moved on the way. */
	delta?: TagDelta;
	/** The workspace this directory declares, if it declares one. */
	workspace?: WorkspaceInfo;
	/** Subprojects no declaration covers — the Python services in a JS monorepo. */
	loose?: WorkspacePackage[];
};

/**
 * The registry's answer, never the manifest's guess.
 *
 * A manifest carries the version someone is about to release; only the registry
 * knows what actually is released. Keeping them apart is the difference between
 * `0.10.4 unreleased` and a bubble that reads as if 0.10.4 shipped.
 */
export type PublishedPackage = {
	/** The `latest` dist-tag, when the registry has one. */
	version?: string;
	/** Where to open it: the package's page on the registry. */
	url: string;
};

export type PackageSummaryReaders = {
	readManifests: typeof readRootManifests;
	readLatestTag: typeof readLatestTag;
	readTagDelta: typeof readTagDelta;
	readWorkspace: typeof readWorkspace;
	readLoosePackages: typeof readLoosePackages;
	/** Optional: tests that do not care about the registry leave it out. */
	readPublished?: typeof readPublishedPackage;
};

const REAL_READERS: PackageSummaryReaders = {
	readManifests: readRootManifests,
	readLatestTag,
	readTagDelta,
	readWorkspace,
	readLoosePackages,
	readPublished: readPublishedPackage,
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

/** Long enough for a warm registry, short enough that a bubble is never waiting. */
const REGISTRY_TIMEOUT_MS = 1500;

/**
 * What `latest` says, or just the page when the registry cannot answer.
 *
 * The link is the package's npm page, not the `homepage` its manifest advertises:
 * a row that says `published` should open the thing that published it, and that
 * is what makes the two facts checkable against each other.
 *
 * A 404 means the package is not published yet, which is worth knowing and is
 * still worth a clickable page. A network failure says nothing at all, so the
 * version stays undefined and the bubble leaves the claim out.
 */
export async function readPublishedPackage(name: string): Promise<PublishedPackage> {
	const page = `https://www.npmjs.com/package/${name}`;
	try {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		});
		if (!response.ok) return { url: page };
		const data = (await response.json()) as { version?: unknown };
		const version = typeof data.version === "string" && data.version ? data.version : undefined;
		return { version, url: page };
	} catch {
		return { url: page };
	}
}

/**
 * `latest` for this directory, cached for the pill.
 *
 * The footer renders on every message, so this is the cheap read: a hit is a map
 * lookup, and only the first refresh of a directory touches the network. A failed
 * answer is retried sooner than a good one, since the registry being down is a
 * state worth leaving.
 */
const PUBLISHED_FRESH_MS = 10 * 60_000;
const PUBLISHED_RETRY_MS = 30_000;
const publishedByCwd = new Map<string, { published: PublishedPackage; at: number }>();

export async function readPublishedVersionForCwd(
	cwd: string,
): Promise<PublishedPackage | undefined> {
	const root = readRootPackageJson(cwd);
	if (!root.name || root.private) return undefined;
	const key = `${cwd}\u0000${root.name}`;
	const cached = publishedByCwd.get(key);
	if (
		cached &&
		Date.now() - cached.at < (cached.published.version ? PUBLISHED_FRESH_MS : PUBLISHED_RETRY_MS)
	) {
		return cached.published;
	}
	const published = await readPublishedPackage(root.name);
	publishedByCwd.set(key, { published, at: Date.now() });
	return published;
}

/**
 * Read everything the bubble draws.
 *
 * The tag is read first because the delta needs it; the manifests and the
 * workspace are local file reads and run beside it. The registry is asked last,
 * and only about a package that has a name and is not private: the rest of the
 * bubble does not wait on the network.
 */
export async function readPackageSummary(
	cwd: string,
	readers: PackageSummaryReaders = REAL_READERS,
): Promise<PackageSummary> {
	const [tag, manifests, workspace] = await Promise.all([
		readers.readLatestTag(cwd),
		Promise.resolve(readers.readManifests(cwd)),
		Promise.resolve(readers.readWorkspace(cwd)),
	]);
	const delta = tag ? await readers.readTagDelta(cwd, tag) : undefined;
	// Only a directory that is a project, or that declares a workspace, has
	// subprojects to look for; anything else would list the neighbours of a
	// scratch directory.
	const loose =
		manifests.length > 0 || workspace
			? readers.readLoosePackages(cwd, workspace?.packages.map((pkg) => pkg.dir) ?? [])
			: [];
	const root = readRootPackageJson(cwd);
	const primary = manifests.find((manifest) => manifest.version);
	const published =
		primary?.ecosystem === "nodejs" && root.name && !root.private
			? await (readers.readPublished ?? readPublishedPackage)(root.name)
			: undefined;
	return {
		manifests,
		name: root.name ?? basename(cwd),
		private: root.private,
		published,
		tag,
		delta,
		workspace,
		loose,
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
 * How many rows one section draws.
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
function packageRows(
	packages: readonly WorkspacePackage[],
	changed: Set<string> | undefined,
): string[] {
	if (packages.length === 0) return ["no package matched the workspace globs"];
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
		// Padded for the rows that carry a mark after the version; one without a mark
		// should not end in spaces the terminal cannot show.
		return `${fitColumn(name, NAME_COLUMNS)} ${version}${
			marks.length > 0 ? `  ${marks.join(" · ")}` : ""
		}`.trimEnd();
	});
	if (packages.length > rows.length) rows.push(`… ${packages.length - rows.length} more`);
	return rows;
}

/**
 * One glyph per publishing platform, so the column says which ecosystem a row is
 * about before the word does. All of these are in Maple Mono NF; anything else
 * falls back to the generic package mark.
 */
const PLATFORM_ICONS: Record<string, string> = {
	nodejs: "\ue71e", // npm
	bun: "\ue76f",
	deno: "\ue7c0",
	rust: "\ue7a8",
	php: "\ue73d",
	dart: "\ue798",
	elixir: "\ue62d",
	haskell: "\ue777",
	python: "\ue73c",
	ruby: "\ue739",
	maven: "\ue738",
	gradle: "\ue660",
	crystal: "\ue62f",
	julia: "\ue624",
	nim: "\ue677",
	helm: "\ue7d8",
};

function platformIcon(ecosystem: string): string {
	return PLATFORM_ICONS[ecosystem] ?? NERD_DEFAULT_ICONS.package;
}

/** Exported for the bubble's tests, which assert the glyph per ecosystem. */
export function iconForEcosystem(ecosystem: string): string {
	return platformIcon(ecosystem);
}

/**
 * Which of two `1.2.3` versions is newer, or undefined when either is not one.
 *
 * Numeric segments only: a prerelease suffix is left out of the comparison, so
 * `1.0.0-rc.1` against `1.0.0` reads as equal rather than inventing an ordering.
 */
function compareVersions(left: string, right: string): number | undefined {
	const parse = (value: string): number[] | undefined => {
		const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
	};
	const a = parse(left);
	const b = parse(right);
	if (!a || !b) return undefined;
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
	}
	return 0;
}

function manifestRows(
	manifest: RootManifest,
	summary: PackageSummary,
	theme: ThemeLike,
	open: (url: string) => void,
): PillBubbleLine[] {
	const isNpm = manifest.ecosystem === "nodejs";
	const published = isNpm ? summary.published : undefined;
	const icon = platformIcon(manifest.ecosystem);
	// The npm mark already spells `npm`, so the word beside it would only repeat it.
	const head = isNpm
		? icon
		: `${icon} ${paint(theme, "accent", ecosystemLabel(manifest.ecosystem))}`;
	const relation = published?.version
		? compareVersions(manifest.version ?? "", published.version)
		: undefined;

	const rows: PillBubbleLine[] = [];
	// The row that says `published` is the one that links: it names what npm has,
	// so opening npm is the way to check it.
	if (published?.version && relation !== 0) {
		rows.push({
			text: `${head} ${paint(theme, "dim", `${published.version} published`)}`,
			onSelect: () => open(published.url),
		});
	}

	const state =
		// `private` is a package.json field: a Python manifest beside it is not
		// affected by the JS package deciding it will not publish.
		manifest.file === "package.json" && summary.private
			? "private"
			: // Only a comparison can say which way round it is: the manifest can be
				// ahead of npm, behind it in a stale checkout, or the same.
				relation === 1
				? "unreleased"
				: relation === -1
					? "older than npm"
					: relation === 0
						? "published"
						: undefined;
	const rest = [manifest.version ?? "--", state, `· ${manifest.file}`].filter(Boolean).join(" ");
	const row = `${head} ${paint(theme, "dim", rest)}`;
	// With the versions equal this row is the published claim, so it links too.
	rows.push(
		relation === 0 && published?.version ? { text: row, onSelect: () => open(published.url) } : row,
	);
	return rows;
}

/** The heading for a section of packages that no workspace manager declares. */
function looseHeading(loose: readonly WorkspacePackage[], theme: ThemeLike): string {
	const ecosystems = [...new Set(loose.map((pkg) => pkg.ecosystem))];
	const label = ecosystems.length === 1 ? ecosystemLabel(ecosystems[0] ?? "") : undefined;
	const head = label ? `${paint(theme, "accent", label)} ` : "";
	return `${head}${paint(theme, "dim", "· not in a workspace")}`;
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
	open: (url: string) => void = openExternalUrl,
): PillBubbleContent {
	const primary = summary.manifests.find((manifest) => manifest.version);
	// No version in the title: a manifest carries the version someone is about to
	// release, and a bubble that leads with it reads as if it had shipped. The line
	// that knows what the registry says is the one that names a release.
	const title = summary.published?.version
		? `${summary.name ?? "Package"} · v${summary.published.version} on npm`
		: (summary.name ?? "Package");

	const body: PillBubbleLine[] = [];
	for (const manifest of summary.manifests) {
		body.push(...manifestRows(manifest, summary, theme, open));
	}

	if (summary.tag) {
		const ahead = summary.delta?.commits ?? 0;
		const state = ahead === 0 ? "tag is HEAD" : `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
		body.push(`󰓹 ${paint(theme, "muted", summary.tag)} ${paint(theme, "dim", `· ${state}`)}`);
	}

	const changedPaths = summary.delta?.paths;
	if (summary.workspace) {
		const count = summary.workspace.packages.length;
		body.push(
			`${paint(theme, "accent", summary.workspace.manager)} ${paint(
				theme,
				"dim",
				`workspace · ${count} package${count === 1 ? "" : "s"}`,
			)}`,
		);
		const changed = changedPaths
			? changedPackageDirs(changedPaths, summary.workspace.packages)
			: undefined;
		for (const row of packageRows(summary.workspace.packages, changed)) body.push(`  ${row}`);
	}

	const loose = summary.loose ?? [];
	if (loose.length > 0) {
		body.push(looseHeading(loose, theme));
		const changed = changedPaths ? changedPackageDirs(changedPaths, loose) : undefined;
		for (const row of packageRows(loose, changed)) body.push(`  ${row}`);
	}

	if (body.length === 0) body.push("No package manifest in this directory.");
	return { title, body };
}
