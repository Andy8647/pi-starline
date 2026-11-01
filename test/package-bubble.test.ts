import { describe, expect, it } from "vitest";
import { NERD_DEFAULT_ICONS } from "../extensions/starline/icons";
import {
	changedPackageDirs,
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

describe("package bubble", () => {
	it("has an action, so the summary is a click away", () => {
		expect(pillActionFor("packageVersion")).toBeTypeOf("function");
	});

	it("names the version, the manifest and what was released", () => {
		const summary: PackageSummary = {
			manifest: { ecosystem: "nodejs", version: "0.10.3", file: "package.json" },
			name: "pi-starline",
			tag: "v0.10.2",
			delta: { commits: 3, paths: [] },
		};

		const content = packageBubbleContent(summary);
		expect(content.title).toBe("0.10.3 · pi-starline");
		expect(content.body).toEqual([
			`${PKG} npm public · package.json`,
			"󰓹 v0.10.2 · 3 commits ahead",
		]);
		expect(content.hint).toBe("esc closes");
	});

	it("says the tag is HEAD when nothing has landed since", () => {
		const content = packageBubbleContent({
			manifest: { ecosystem: "python", version: "2.1.0", file: "pyproject.toml" },
			name: "acme",
			tag: "2.1.0",
			delta: { commits: 0, paths: [] },
		});

		expect(content.body[1]).toBe("󰓹 2.1.0 · tag is HEAD");
	});

	it("marks a package nothing is published from", () => {
		const content = packageBubbleContent({
			manifest: { ecosystem: "nodejs", version: "0.0.3", file: "package.json" },
			name: "pi-monorepo",
			private: true,
		});

		expect(content.body).toEqual([`${PKG} npm private · package.json`]);
	});

	it("leaves the release line out when the repository has no tag", () => {
		const content = packageBubbleContent({
			manifest: { ecosystem: "rust", version: "0.4.2", file: "Cargo.toml" },
			name: "acme",
		});

		expect(content.body).toEqual([`${PKG} cargo public · Cargo.toml`]);
	});

	it("lists a workspace, with the packages the tag's diff touched", () => {
		const summary: PackageSummary = {
			manifest: { ecosystem: "nodejs", version: "0.0.3", file: "package.json" },
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
		expect(content.body).toEqual([
			`${PKG} npm private · package.json`,
			"󰓹 v0.99.0 · 12 commits ahead",
			"pnpm workspace · 3 packages",
			"  ai                       1.2.0  changed",
			"  @scope/tui               0.4.1  changed",
			"  cli                      --     private",
		]);
	});

	it("says a workspace matched nothing rather than drawing an empty list", () => {
		const content = packageBubbleContent({
			name: "acme",
			workspace: { manager: "cargo", packages: [] },
		});

		expect(content.body).toEqual([
			"cargo workspace · 0 packages",
			"  no package matched the workspace globs",
		]);
	});

	it("falls back to the directory name when there is no manifest", () => {
		const content = packageBubbleContent({ name: "scratch" });

		expect(content.title).toBe("scratch");
		expect(content.body).toEqual(["No package manifest in this directory."]);
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
	it("reads the manifest and the workspace without asking git for a delta with no tag", async () => {
		const summary = await readPackageSummary("/tmp/acme", {
			readManifest: () => ({ ecosystem: "nodejs", version: "1.2.3", file: "package.json" }),
			readLatestTag: async () => undefined,
			readTagDelta: async () => {
				throw new Error("no tag, so no diff");
			},
			readWorkspace: () => ({ manager: "pnpm", packages: [member("packages/ui", "ui", "1.0.0")] }),
		});

		expect(summary.tag).toBeUndefined();
		expect(summary.delta).toBeUndefined();
		expect(summary.manifest?.version).toBe("1.2.3");
		expect(summary.name).toBe("acme");
		expect(summary.workspace?.manager).toBe("pnpm");
	});

	it("measures HEAD against the tag it was given", async () => {
		const asked: string[] = [];
		const summary = await readPackageSummary("/tmp/acme", {
			readManifest: () => null,
			readLatestTag: async () => "v1.2.2",
			readTagDelta: async (_cwd, tag) => {
				asked.push(tag);
				return { commits: 2, paths: ["packages/ui/index.ts"] };
			},
			readWorkspace: () => undefined,
		});

		expect(asked).toEqual(["v1.2.2"]);
		expect(summary.delta?.commits).toBe(2);
	});
});
