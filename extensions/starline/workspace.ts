/**
 * Which packages a repository publishes, and what version each is at.
 *
 * A workspace says this itself — `pnpm-workspace.yaml`, `package.json#workspaces`,
 * `Cargo.toml [workspace] members`, `go.work`, `deno.json#workspace`,
 * `[tool.uv.workspace]` — so detection is a manifest read, not a directory
 * crawl. The crawl is only the glob expansion, and it is bounded: `*` is one
 * level, `**` stops at a depth cap, dependency and build directories are never
 * entered, and the list is capped. A pattern that would walk `node_modules` is
 * the one way this turns into a slow read on a bubble open.
 *
 * Versions come from the same reader the pill uses (`readPackageVersion`), so a
 * package row and the root segment cannot disagree about how a version is
 * spelled.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readPackageVersion } from "./package-version";

export type WorkspacePackage = {
	/** Directory relative to the workspace root, POSIX separators. */
	dir: string;
	/** The manifest's own name, else the directory's basename. */
	name: string;
	/** Undefined when the manifest declares no version (a private root, a library). */
	version?: string;
	/** Starship ecosystem key, from `readPackageVersion`. */
	ecosystem: string;
	/** `package.json#private`: nothing is published from this package. */
	private?: boolean;
};

export type WorkspaceInfo = {
	/** What declared the packages: `pnpm`, `npm`, `bun`, `cargo`, `go`, `deno`, `uv`. */
	manager: string;
	packages: WorkspacePackage[];
};

/** Never descended into, at any depth: these are dependencies or build output. */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".venv",
	"venv",
	"__pycache__",
	"target",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	"vendor",
	"Pods",
	"DerivedData",
]);

/** Deep enough for a two-level workspace, short of a crawl. */
const MAX_DEPTH = 6;
/** A workspace this size is a dependency graph, not something to draw in a bubble. */
const MAX_PACKAGES = 50;
/** Bound on glob matches before the manifest filter runs, so `**` cannot fan out. */
const MAX_MATCHES = 400;

function safeRead(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Child directories of `dir`, minus the ones no package lives under. */
function childDirs(dir: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (SKIP_DIRS.has(entry.name)) continue;
		// A dot directory is editor state, a git worktree or a tool cache.
		if (entry.name.startsWith(".") && entry.name !== ".") continue;
		out.push(entry.name);
	}
	return out.sort();
}

// --- Manifest declaration readers ---------------------------------------

/** `packages:` from `pnpm-workspace.yaml`: a list of quoted or bare globs. */
function pnpmPatterns(raw: string): readonly string[] | undefined {
	const patterns: string[] = [];
	let inPackages = false;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!line.startsWith(" ") && !line.startsWith("\t")) {
			inPackages = /^packages\s*:/.test(trimmed);
			continue;
		}
		if (!inPackages) continue;
		const match = trimmed.match(/^-\s*(.+?)\s*$/);
		if (match?.[1]) patterns.push(unquote(match[1]));
	}
	return patterns.length > 0 ? patterns : undefined;
}

function unquote(value: string): string {
	const text = value.trim();
	if (text.length >= 2) {
		const first = text[0];
		const last = text[text.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return text.slice(1, -1);
		}
	}
	return text;
}

/** `package.json#workspaces`, in either the array or the `{ packages: [] }` form. */
function npmPatterns(raw: string): readonly string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const workspaces = (parsed as { workspaces?: unknown }).workspaces;
	const list = Array.isArray(workspaces)
		? workspaces
		: workspaces &&
				typeof workspaces === "object" &&
				Array.isArray((workspaces as { packages?: unknown }).packages)
			? ((workspaces as { packages: unknown[] }).packages as unknown[])
			: undefined;
	if (!list) return undefined;
	const patterns = list.filter((entry): entry is string => typeof entry === "string");
	return patterns.length > 0 ? patterns : undefined;
}

/**
 * A `key = [ "a", "b" ]` array inside a TOML section, across lines.
 *
 * Only the static array form is read; `{ workspace = true }` inheritance and
 * bare-key arrays of tables are left alone, because a member list is the one
 * thing a workspace always spells out.
 */
function tomlSectionArray(
	raw: string,
	section: string,
	key: string,
): readonly string[] | undefined {
	const lines = raw.split(/\r?\n/);
	let inSection = false;
	let collecting = false;
	const collected: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!collecting && !trimmed.startsWith("#")) {
			const header = trimmed.match(/^\[\[?([^\]]+)\]?\]\s*$/);
			if (header) {
				inSection = (header[1] ?? "").trim() === section;
				continue;
			}
			if (!inSection) continue;
			const start = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*\[(.*)$/);
			if (!start || (start[1] ?? "") !== key) continue;
			collecting = true;
			collected.push(start[2] ?? "");
		} else if (collecting) {
			collected.push(trimmed);
		}
		if (collecting) {
			const tail = collected.join(" ");
			if (tail.includes("]")) break;
		}
	}
	if (!collecting) return undefined;
	const body = collected.join(" ").split("]")[0] ?? "";
	const patterns = [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] ?? "");
	return patterns.length > 0 ? patterns : undefined;
}

/** `use ( ./a \n ./b )` or `use ./a` from `go.work`. */
function goWorkPatterns(raw: string): readonly string[] | undefined {
	const patterns: string[] = [];
	const block = raw.match(/\buse\s*\(([\s\S]*?)\)/);
	if (block) {
		for (const line of (block[1] ?? "").split(/\r?\n/)) {
			const path = unquote(line.replace(/\/\/.*$/, "").trim());
			if (path) patterns.push(path);
		}
		return patterns.length > 0 ? patterns : undefined;
	}
	for (const line of raw.split(/\r?\n/)) {
		const match = line.trim().match(/^use\s+(.+)$/);
		const path = match?.[1] ? unquote(match[1].trim()) : "";
		if (path) patterns.push(path);
	}
	return patterns.length > 0 ? patterns : undefined;
}

/** `deno.json#workspace`: a list of member paths. */
function denoPatterns(raw: string): readonly string[] | undefined {
	const withoutComments = raw.replace(/^\s*\/\/.*$/gm, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutComments);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const list = (parsed as { workspace?: unknown }).workspace;
	if (!Array.isArray(list)) return undefined;
	const patterns = list.filter((entry): entry is string => typeof entry === "string");
	return patterns.length > 0 ? patterns : undefined;
}

/** `[tool.uv.workspace] members` from `pyproject.toml`. */
function uvPatterns(raw: string): readonly string[] | undefined {
	return tomlSectionArray(raw, "tool.uv.workspace", "members");
}

/**
 * The managers that can own this package.json, from the lockfile beside it.
 * Only a label: `package.json#workspaces` means the same thing to all of them.
 */
function npmManager(cwd: string): string {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

type WorkspaceSource = {
	manager: string;
	file: string;
	patterns: (raw: string, cwd: string) => readonly string[] | undefined;
};

/** Ordered: the file that owns the member list wins over the one beside it. */
const SOURCES: readonly WorkspaceSource[] = [
	{ manager: "pnpm", file: "pnpm-workspace.yaml", patterns: pnpmPatterns },
	{ manager: "npm", file: "package.json", patterns: npmPatterns },
	{
		manager: "cargo",
		file: "Cargo.toml",
		patterns: (raw) => tomlSectionArray(raw, "workspace", "members"),
	},
	{ manager: "go", file: "go.work", patterns: goWorkPatterns },
	{ manager: "deno", file: "deno.json", patterns: denoPatterns },
	{ manager: "deno", file: "deno.jsonc", patterns: denoPatterns },
	{ manager: "uv", file: "pyproject.toml", patterns: uvPatterns },
];

// --- Glob expansion ------------------------------------------------------

/** Drop a trailing slash and a leading `./`, which both forms of glob allow. */
function normalizePattern(pattern: string): string {
	return pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Every directory a single pattern matches, relative to the root. */
export function matchDirs(root: string, pattern: string): string[] {
	const segments = normalizePattern(pattern)
		.split("/")
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) return [];

	const out: string[] = [];
	const walk = (relative: string, remaining: readonly string[], depth: number): void => {
		if (out.length >= MAX_MATCHES || depth > MAX_DEPTH) return;
		const [head, ...rest] = remaining;
		if (head === undefined) {
			if (relative) out.push(relative);
			return;
		}
		if (head === "**") {
			// Zero directories, then every child with `**` still to spend.
			walk(relative, rest, depth + 1);
			for (const child of childDirs(join(root, relative))) {
				walk(relative ? `${relative}/${child}` : child, remaining, depth + 1);
			}
			return;
		}
		if (head.includes("*")) {
			// `apps/*` and `apps/*-service` are the same walk; only the filter differs.
			const matches = segmentMatcher(head);
			for (const child of childDirs(join(root, relative))) {
				if (!matches(child)) continue;
				walk(relative ? `${relative}/${child}` : child, rest, depth + 1);
			}
			return;
		}
		const next = relative ? `${relative}/${head}` : head;
		if (isDirectory(join(root, next))) walk(next, rest, depth + 1);
	};

	walk("", segments, 0);
	return out;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern segment as a test.
 *
 * `*` is the only wildcard inside a segment, and it never crosses a `/`:
 * `packages/internal-*` is one level, and `**` is not this function's business.
 */
function segmentMatcher(segment: string): (name: string) => boolean {
	if (!segment.includes("*")) return (name) => name === segment;
	const source = segment.split("*").map(escapeRegExp).join("[^/]*");
	const pattern = new RegExp(`^${source}$`);
	return (name) => pattern.test(name);
}

/** Resolve include and `!` exclude patterns to one ordered directory list. */
export function expandPatterns(root: string, patterns: readonly string[]): string[] {
	const include: string[] = [];
	const exclude = new Set<string>();
	for (const pattern of patterns) {
		const negated = pattern.trim().startsWith("!");
		const body = normalizePattern(negated ? pattern.trim().slice(1) : pattern);
		if (!body) continue;
		const matched = matchDirs(root, body);
		if (negated) for (const dir of matched) exclude.add(dir);
		else include.push(...matched);
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dir of include) {
		if (exclude.has(dir) || seen.has(dir)) continue;
		seen.add(dir);
		out.push(dir);
	}
	return out;
}

// --- Reading each member -------------------------------------------------

function readJsonRecord(path: string): Record<string, unknown> | undefined {
	const raw = safeRead(path);
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The `name` of a `[package]` section in a Cargo manifest, as a literal string. */
function cargoName(raw: string): string | undefined {
	const match = raw.match(/\[package\][\s\S]*?^name\s*=\s*["']([^"']+)["']/m);
	return match?.[1];
}

/**
 * One member directory as a row: name, version, and whether it is published.
 *
 * A package without a version is still a package — a private monorepo root and
 * an internal library both look like that — so the manifest's presence, not the
 * version, decides whether the directory belongs in the list.
 */
function readMember(root: string, dir: string): WorkspacePackage | undefined {
	const full = join(root, dir);
	const pkg = readJsonRecord(join(full, "package.json"));
	const version = readPackageVersion(full);
	// A Go module carries no version at all; its path is the only identity it has,
	// and leaving it out would hide every Go workspace member.
	const moduleName = (safeRead(join(full, "go.mod")) ?? "").match(/^module\s+(\S+)/m)?.[1];
	if (!pkg && !version && !moduleName) return undefined;

	const basename = dir.slice(dir.lastIndexOf("/") + 1);
	const name =
		typeof pkg?.name === "string" && pkg.name
			? pkg.name
			: ((version?.file === "Cargo.toml"
					? cargoName(safeRead(join(full, "Cargo.toml")) ?? "")
					: undefined) ??
				moduleName ??
				basename);

	return {
		dir,
		name,
		version: version?.version,
		ecosystem: version?.ecosystem ?? (moduleName ? "go" : "nodejs"),
		private: pkg?.private === true ? true : undefined,
	};
}

/**
 * The workspace this directory declares, or `undefined` when it declares none.
 *
 * `undefined` and an empty package list mean different things: the first is
 * "not a workspace", the second is a workspace whose globs matched nothing —
 * which the bubble should say out loud rather than hide.
 */
export function readWorkspace(cwd: string): WorkspaceInfo | undefined {
	for (const source of SOURCES) {
		const raw = safeRead(join(cwd, source.file));
		if (raw === undefined) continue;
		const patterns = source.patterns(raw, cwd);
		if (!patterns) continue;
		const manager = source.manager === "npm" ? npmManager(cwd) : source.manager;
		const packages: WorkspacePackage[] = [];
		for (const dir of expandPatterns(cwd, patterns)) {
			if (packages.length >= MAX_PACKAGES) break;
			const member = readMember(cwd, dir);
			if (member) packages.push(member);
		}
		return { manager, packages };
	}
	return undefined;
}

/** How deep a repository without a workspace declaration is still looked at. */
const LOOSE_DEPTH = 2;

/**
 * Subprojects no workspace declaration covers.
 *
 * A mixed repository is the case this exists for: `apps/web` is a pnpm
 * workspace member, and the Python services beside it (`apps/api`,
 * `packages/domain`) belong to nothing at all. Listing only the declared
 * member would describe a four-package repository as a one-package one.
 *
 * Two levels, not a crawl, and a directory that has a manifest is not entered:
 * a package's internals are not subprojects. Directories a workspace already
 * lists are skipped, so nothing appears twice.
 */
export function readLoosePackages(cwd: string, known: Iterable<string> = []): WorkspacePackage[] {
	const seen = new Set(known);
	const packages: WorkspacePackage[] = [];
	const walk = (relative: string, depth: number): void => {
		if (packages.length >= MAX_PACKAGES || depth >= LOOSE_DEPTH) return;
		for (const child of childDirs(join(cwd, relative))) {
			const dir = relative ? `${relative}/${child}` : child;
			if (seen.has(dir)) continue;
			const member = readMember(cwd, dir);
			if (member) {
				packages.push(member);
				continue;
			}
			walk(dir, depth + 1);
		}
	};
	walk("", 0);
	return packages;
}
