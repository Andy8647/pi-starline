import { describe, expect, it } from "vitest";
import { NERD_DEFAULT_ICONS } from "../extensions/starline/icons";
import {
	changedPackageDirs,
	iconForEcosystem,
	type PackageSummary,
	packageBubbleContent,
	readPackageSummary,
} from "../extensions/starline/package-summary";
import { pillActionFor } from "../extensions/starline/pill-actions";
import type { WorkspacePackage } from "../extensions/starline/workspace";

function member(
	dir: string,
	name: string,
	version: string | undefined,
	extra: Partial<WorkspacePackage> = {},
): WorkspacePackage {
	return { dir, name, version, ecosystem: "nodejs", ...extra };
}

const PKG = NERD_DEFAULT_ICONS.package;
const NPM = iconForEcosystem("nodejs");
const PYTHON = iconForEcosystem("python");
const CARGO = iconForEcosystem("rust");

/** What a plain string row says; link rows are objects. */
function textOf(line: unknown): string {
	return typeof line === "string" ? line : ((line as { text: string }).text ?? "");
}

describe("package bubble", () => {
	it("has an action, so the summary is a click away", () => {
		expect(pillActionFor("packageVersion")).toBeTypeOf("function");
	});

	it("names the version, the manifest and what was released", () => {
		const summary: PackageSummary = {
			manifests: [{ ecosystem: "nodejs", version: "0.10.3", file: "package.json" }],
			name: "pi-starline",
			tag: "v0.10.2",
			delta: { commits: 3, paths: [] },
		};

		const content = packageBubbleContent(summary);
		// No registry answer, so no claim about what is released: the title is just
		// the name and the row just the manifest.
		expect(content.title).toBe("pi-starline");
		expect(content.body.map(textOf)).toEqual([
			`${NPM} 0.10.3 · package.json`,
			"󰓹 v0.10.2 · 3 commits ahead",
		]);
	});

	it("says which version the registry has, and calls the local one unreleased", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "nodejs", version: "0.10.4", file: "package.json" }],
			name: "pi-starline",
			published: { version: "0.10.3", url: "https://example.test/starline" },
		});

		expect(content.title).toBe("pi-starline · v0.10.3 on npm");
		expect(content.body.map(textOf)).toEqual([
			`${NPM} 0.10.3 published`,
			`${NPM} 0.10.4 unreleased · package.json`,
		]);
	});

	it("says one row when the manifest is what is published", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "nodejs", version: "0.10.3", file: "package.json" }],
			name: "pi-starline",
			published: { version: "0.10.3", url: "https://example.test/starline" },
		});

		expect(content.body.map(textOf)).toEqual([`${NPM} 0.10.3 published · package.json`]);
	});

	it("makes the npm row a link to the package page", () => {
		const opened: string[] = [];
		const content = packageBubbleContent(
			{
				manifests: [{ ecosystem: "nodejs", version: "0.10.3", file: "package.json" }],
				name: "pi-starline",
				published: { version: "0.10.3", url: "https://example.test/starline" },
			},
			undefined,
			(url) => opened.push(url),
		);

		const row = content.body[0] as { onSelect: () => void };
		row.onSelect();
		expect(opened).toEqual(["https://example.test/starline"]);
	});

	it("links only the row that claims something is published", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "nodejs", version: "0.10.4", file: "package.json" }],
			name: "pi-starline",
			published: { version: "0.10.3", url: "https://www.npmjs.com/package/pi-starline" },
		});

		expect(content.body[0]).toMatchObject({ onSelect: expect.any(Function) });
		expect(typeof content.body[1]).toBe("string");
	});

	it("says older than npm when the checkout is behind", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "nodejs", version: "0.10.2", file: "package.json" }],
			name: "pi-starline",
			published: { version: "0.10.3", url: "https://www.npmjs.com/package/pi-starline" },
		});

		expect(content.body.map(textOf)).toEqual([
			`${NPM} 0.10.3 published`,
			`${NPM} 0.10.2 older than npm · package.json`,
		]);
	});

	it("says the tag is HEAD when nothing has landed since", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "python", version: "2.1.0", file: "pyproject.toml" }],
			name: "acme",
			tag: "2.1.0",
			delta: { commits: 0, paths: [] },
		});

		expect(content.body[1]).toBe("󰓹 2.1.0 · tag is HEAD");
	});

	it("marks a package nothing is published from", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "nodejs", version: "0.0.3", file: "package.json" }],
			name: "pi-monorepo",
			private: true,
		});

		expect(content.body.map(textOf)).toEqual([`${NPM} 0.0.3 private · package.json`]);
	});

	it("leaves the release line out when the repository has no tag", () => {
		const content = packageBubbleContent({
			manifests: [{ ecosystem: "rust", version: "0.4.2", file: "Cargo.toml" }],
			name: "acme",
		});

		expect(content.body.map(textOf)).toEqual([`${CARGO} cargo 0.4.2 · Cargo.toml`]);
	});

	it("names every manifest, so a mixed repository is not described as one ecosystem", () => {
		const content = packageBubbleContent({
			manifests: [
				{ ecosystem: "nodejs", file: "package.json" },
				{ ecosystem: "python", version: "0.1.0", file: "pyproject.toml" },
			],
			name: "mwac-space-navigator",
			private: true,
		});

		expect(content.title).toBe("mwac-space-navigator");
		expect(content.body.map(textOf)).toEqual([
			`${NPM} -- private · package.json`,
			`${PYTHON} python 0.1.0 · pyproject.toml`,
		]);
	});

	it("lists a workspace, with the packages the tag's diff touched", () => {
		const summary: PackageSummary = {
			manifests: [{ ecosystem: "nodejs", version: "0.0.3", file: "package.json" }],
			name: "pi-monorepo",
			private: true,
			tag: "v0.99.0",
			delta: {
				commits: 12,
				paths: ["packages/ai/src/index.ts", "README.md", "packages/tui/package.json"],
			},
			workspace: {
				manager: "pnpm",
				packages: [
					member("packages/ai", "ai", "1.2.0"),
					member("packages/tui", "@scope/tui", "0.4.1"),
					member("packages/cli", "cli", undefined, { private: true }),
				],
			},
		};

		const content = packageBubbleContent(summary);
		expect(content.body.map(textOf)).toEqual([
			`${NPM} 0.0.3 private · package.json`,
			"󰓹 v0.99.0 · 12 commits ahead",
			"pnpm workspace · 3 packages",
			"  ai                       1.2.0  changed",
			"  @scope/tui               0.4.1  changed",
			"  cli                      --     private",
		]);
	});

	it("lists the subprojects no workspace declares", () => {
		const summary: PackageSummary = {
			manifests: [
				{ ecosystem: "nodejs", file: "package.json" },
				{ ecosystem: "python", version: "0.1.0", file: "pyproject.toml" },
			],
			name: "mwac-space-navigator",
			private: true,
			tag: "v0.1.0",
			delta: { commits: 4, paths: ["apps/api/mwac_api/main.py", "apps/web/src/App.tsx"] },
			workspace: {
				manager: "pnpm",
				packages: [member("apps/web", "web", "0.1.0", { private: true })],
			},
			loose: [
				{ dir: "apps/api", name: "api", version: "0.1.0", ecosystem: "python" },
				{ dir: "apps/ingest", name: "ingest", version: undefined, ecosystem: "python" },
			],
		};

		const content = packageBubbleContent(summary);
		expect(content.body.map(textOf)).toEqual([
			`${NPM} -- private · package.json`,
			`${PYTHON} python 0.1.0 · pyproject.toml`,
			"󰓹 v0.1.0 · 4 commits ahead",
			"pnpm workspace · 1 package",
			"  web                      0.1.0  changed · private",
			"python · not in a workspace",
			"  api                      0.1.0  changed",
			"  ingest                   --",
		]);
	});

	it("names the ecosystem only when every loose package shares one", () => {
		const summary: PackageSummary = {
			manifests: [{ ecosystem: "nodejs", version: "1.0.0", file: "package.json" }],
			name: "mixed",
			loose: [
				{ dir: "svc/api", name: "api", version: "1.0.0", ecosystem: "python" },
				{ dir: "svc/web", name: "web", version: "1.0.0", ecosystem: "nodejs" },
			],
		};

		expect(packageBubbleContent(summary).body.map(textOf)).toContain("· not in a workspace");
	});

	it("says a workspace matched nothing rather than drawing an empty list", () => {
		const content = packageBubbleContent({
			manifests: [],
			name: "acme",
			workspace: { manager: "cargo", packages: [] },
		});

		expect(content.body.map(textOf)).toEqual([
			"cargo workspace · 0 packages",
			"  no package matched the workspace globs",
		]);
	});

	it("falls back to the directory name when there is no manifest", () => {
		const content = packageBubbleContent({ manifests: [], name: "scratch" });

		expect(content.title).toBe("scratch");
		expect(content.body.map(textOf)).toEqual(["No package manifest in this directory."]);
	});
});

describe("changedPackageDirs", () => {
	const packages = [
		member("packages/ai", "ai", "1.0.0"),
		member("packages/api", "api", "1.0.0"),
		member("packages/api-client", "api-client", "1.0.0"),
	];

	it("attributes a path to the package it is under, not to a sibling with the same prefix", () => {
		const changed = changedPackageDirs(["packages/api/src/main.ts"], packages);
		expect([...changed]).toEqual(["packages/api"]);
	});

	it("counts a manifest edit at the package root", () => {
		const changed = changedPackageDirs(["packages/ai/package.json"], packages);
		expect([...changed]).toEqual(["packages/ai"]);
	});

	it("ignores a path outside every package", () => {
		expect(changedPackageDirs(["README.md", "pnpm-workspace.yaml"], packages).size).toBe(0);
	});
});

describe("readPackageSummary", () => {
	it("reads the manifests and the workspace without asking git for a delta with no tag", async () => {
		const summary = await readPackageSummary("/tmp/acme", {
			readManifests: () => [{ ecosystem: "nodejs", version: "1.2.3", file: "package.json" }],
			readLatestTag: async () => undefined,
			readTagDelta: async () => {
				throw new Error("no tag, so no diff");
			},
			readWorkspace: () => ({ manager: "pnpm", packages: [member("packages/ui", "ui", "1.0.0")] }),
			readLoosePackages: () => [],
		});

		expect(summary.tag).toBeUndefined();
		expect(summary.delta).toBeUndefined();
		expect(summary.manifests[0]?.version).toBe("1.2.3");
		expect(summary.name).toBe("acme");
		expect(summary.workspace?.manager).toBe("pnpm");
	});

	it("measures HEAD against the tag it was given", async () => {
		const asked: string[] = [];
		const summary = await readPackageSummary("/tmp/acme", {
			readManifests: () => [],
			readLatestTag: async () => "v1.2.2",
			readTagDelta: async (_cwd, tag) => {
				asked.push(tag);
				return { commits: 2, paths: ["packages/ui/index.ts"] };
			},
			readWorkspace: () => undefined,
			readLoosePackages: () => [],
		});

		expect(asked).toEqual(["v1.2.2"]);
		expect(summary.delta?.commits).toBe(2);
	});

	it("skips the subproject scan in a directory that is not a project", async () => {
		const asked: string[] = [];
		const summary = await readPackageSummary("/tmp/scratch", {
			readManifests: () => [],
			readLatestTag: async () => undefined,
			readTagDelta: async () => undefined,
			readWorkspace: () => undefined,
			readLoosePackages: (cwd) => {
				asked.push(cwd);
				return [];
			},
		});

		expect(asked).toEqual([]);
		expect(summary.loose).toEqual([]);
	});

	it("hands the workspace's own packages to the subproject scan so nothing is listed twice", async () => {
		const seen: string[][] = [];
		await readPackageSummary("/tmp/acme", {
			readManifests: () => [{ ecosystem: "nodejs", version: "1.0.0", file: "package.json" }],
			readLatestTag: async () => undefined,
			readTagDelta: async () => undefined,
			readWorkspace: () => ({
				manager: "pnpm",
				packages: [member("apps/web", "web", "1.0.0")],
			}),
			readLoosePackages: (_cwd, known) => {
				seen.push([...(known ?? [])]);
				return [];
			},
		});

		expect(seen).toEqual([["apps/web"]]);
	});
});
