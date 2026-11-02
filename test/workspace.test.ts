import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	expandPatterns,
	matchDirs,
	readLoosePackages,
	readWorkspace,
} from "../extensions/starline/workspace";

function makeTree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "starline-workspace-"));
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return root;
}

function pkg(name: string, version?: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ name, ...(version ? { version } : {}), ...extra }, null, 2);
}

describe("workspace detection", () => {
	it("reads pnpm-workspace.yaml, including literal member paths", () => {
		const root = makeTree({
			"pnpm-workspace.yaml": "packages:\n  - 'apps/web'\n  - 'packages/*'\n",
			"apps/web/package.json": pkg("@acme/web", "1.2.0"),
			"packages/ui/package.json": pkg("@acme/ui", "0.3.1"),
			"packages/docs/README.md": "# not a package\n",
		});

		const workspace = readWorkspace(root);
		expect(workspace?.manager).toBe("pnpm");
		expect(workspace?.packages.map((entry) => [entry.dir, entry.name, entry.version])).toEqual([
			["apps/web", "@acme/web", "1.2.0"],
			["packages/ui", "@acme/ui", "0.3.1"],
		]);
	});

	it("reads package.json workspaces at more than one depth, named by its lockfile", () => {
		const root = makeTree({
			"package.json": JSON.stringify({
				name: "root",
				private: true,
				workspaces: ["packages/*", "packages/session-backends/*"],
			}),
			"package-lock.json": "{}",
			"packages/ai/package.json": pkg("ai", "0.9.0"),
			"packages/session-backends/sqlite/package.json": pkg("sqlite", "0.1.0"),
			"packages/README.md": "not a package\n",
		});

		const workspace = readWorkspace(root);
		expect(workspace?.manager).toBe("npm");
		expect(workspace?.packages.map((entry) => entry.name)).toEqual(["ai", "sqlite"]);
	});

	it("keeps a package that declares no version, and marks it private", () => {
		const root = makeTree({
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
			"packages/app/package.json": pkg("@acme/app", undefined, { private: true }),
		});

		const workspace = readWorkspace(root);
		expect(workspace?.packages).toEqual([
			{
				dir: "packages/app",
				name: "@acme/app",
				version: undefined,
				ecosystem: "nodejs",
				private: true,
			},
		]);
	});

	it("reads cargo workspace members and their package names", () => {
		const root = makeTree({
			"Cargo.toml": '[workspace]\nmembers = [\n  "crates/core",\n  "crates/cli",\n]\n',
			"crates/core/Cargo.toml": '[package]\nname = "acme-core"\nversion = "0.4.2"\n',
			"crates/cli/Cargo.toml": '[package]\nname = "acme-cli"\nversion = "0.4.2"\n',
		});

		const workspace = readWorkspace(root);
		expect(workspace?.manager).toBe("cargo");
		expect(workspace?.packages.map((entry) => [entry.name, entry.version])).toEqual([
			["acme-core", "0.4.2"],
			["acme-cli", "0.4.2"],
		]);
	});

	it("reads go.work members", () => {
		const root = makeTree({
			"go.work": "go 1.24\n\nuse (\n\t./svc/api\n)\n",
			"svc/api/go.mod": "module example.com/api\n\ngo 1.24\n",
		});

		const workspace = readWorkspace(root);
		expect(workspace?.manager).toBe("go");
		expect(workspace?.packages.map((entry) => entry.dir)).toEqual(["svc/api"]);
	});

	it("drops a member the same file excludes", () => {
		const root = makeTree({
			"pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/internal-*'\n",
			"packages/ui/package.json": pkg("ui", "1.0.0"),
			"packages/internal-tools/package.json": pkg("internal-tools", "1.0.0"),
		});

		expect(readWorkspace(root)?.packages.map((entry) => entry.name)).toEqual(["ui"]);
	});

	it("is not a workspace when nothing declares one", () => {
		const root = makeTree({ "package.json": pkg("solo", "2.0.0") });
		expect(readWorkspace(root)).toBeUndefined();
	});
});

describe("packages outside any declaration", () => {
	it("finds the subprojects a workspace does not list", () => {
		const root = makeTree({
			"package.json": JSON.stringify({ name: "mixed", private: true }),
			"pyproject.toml": '[project]\nname = "mixed"\nversion = "0.1.0"\n',
			"pnpm-workspace.yaml": "packages:\n  - 'apps/web'\n",
			"apps/web/package.json": pkg("web", "0.1.0", { private: true }),
			"apps/api/pyproject.toml": '[project]\nname = "api"\nversion = "0.1.0"\n',
			"apps/ingest/pyproject.toml": '[project]\nname = "ingest"\nversion = "0.1.0"\n',
			"apps/web/node_modules/dep/package.json": pkg("dep", "9.9.9"),
			"docs/notes.md": "not a package\n",
		});

		const workspace = readWorkspace(root);
		const loose = readLoosePackages(root, workspace?.packages.map((entry) => entry.dir) ?? []);
		expect(loose.map((entry) => [entry.dir, entry.version, entry.ecosystem])).toEqual([
			["apps/api", "0.1.0", "python"],
			["apps/ingest", "0.1.0", "python"],
		]);
	});

	it("stops at a package rather than reading the package's own directories", () => {
		const root = makeTree({
			"apps/api/pyproject.toml": '[project]\nversion = "0.1.0"\n',
			"apps/api/inner/package.json": pkg("inner", "1.0.0"),
		});

		expect(readLoosePackages(root).map((entry) => entry.dir)).toEqual(["apps/api"]);
	});

	it("looks two levels deep, not further", () => {
		const root = makeTree({
			"a/b/package.json": pkg("b", "1.0.0"),
			"a/b/c/package.json": pkg("c", "1.0.0"),
			"a/b2/d/package.json": pkg("d", "1.0.0"),
		});

		expect(readLoosePackages(root).map((entry) => entry.dir)).toEqual(["a/b"]);
	});
});

describe("glob expansion", () => {
	it("never descends into dependency or build directories", () => {
		const root = makeTree({
			"packages/ui/package.json": pkg("ui", "1.0.0"),
			"packages/ui/node_modules/dep/package.json": pkg("dep", "9.9.9"),
			"packages/ui/dist/package.json": pkg("dist", "9.9.9"),
		});

		expect(matchDirs(root, "**")).toEqual(["packages", "packages/ui"]);
	});

	it("spends `**` at any depth under the pattern that declares it", () => {
		const root = makeTree({
			"apps/web/package.json": pkg("web", "1.0.0"),
			"apps/web/packages/widget/package.json": pkg("widget", "1.0.0"),
			"tools/x/package.json": pkg("x", "1.0.0"),
		});

		// `**` also matches zero directories, so the parent comes back with the children;
		// a directory with no manifest is dropped when the members are read.
		expect(matchDirs(root, "apps/**")).toEqual([
			"apps",
			"apps/web",
			"apps/web/packages",
			"apps/web/packages/widget",
		]);
		expect(expandPatterns(root, ["apps/*"])).toEqual(["apps/web"]);
	});
});
