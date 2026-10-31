import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { emptyGitStatus, type GitReadResult } from "../extensions/starline/git";
import { type ProjectProbeReaders, probeProject } from "../extensions/starline/project-probe";
import { applyProjectRefreshToState } from "../extensions/starline/project-state";
import { createInitialState } from "../extensions/starline/state";

function configWith(
	segments: string[],
	overrides: Partial<PolishedTuiConfig> = {},
): PolishedTuiConfig {
	return {
		...defaultConfig,
		pill: { ...defaultConfig.pill, segments },
		...overrides,
	};
}

const branchStatus: GitReadResult = {
	kind: "ok",
	status: { ...emptyGitStatus(), branch: "main", dirty: true, modified: 2 },
};

function readers(git: GitReadResult = branchStatus) {
	const readGitStatus = vi.fn(async () => git);
	const readGitHost = vi.fn(async () => "github" as const);
	const readRuntimeInfo = vi.fn(async () => ({ kind: "ok" as const }));
	const readPackageVersion = vi.fn(async () => ({
		kind: "ok" as const,
		result: { version: "1.2.3", ecosystem: "node" },
	}));
	const readPullSnapshot = vi.fn(async () => undefined);
	const deps: ProjectProbeReaders = {
		readGitStatus,
		readGitHost,
		readPullSnapshot,
		readRuntimeInfo,
		readPackageVersion,
	};
	return {
		deps,
		readGitStatus,
		readGitHost,
		readPullSnapshot,
		readRuntimeInfo,
		readPackageVersion,
	};
}

describe("probeProject", () => {
	it("reads no git at all when the bar has no git pill", async () => {
		const { deps, readGitStatus, readGitHost, readRuntimeInfo } = readers();

		const probe = await probeProject("/tmp/project", configWith(["model", "cwd", "context"]), deps);

		expect(readGitStatus).not.toHaveBeenCalled();
		expect(readGitHost).not.toHaveBeenCalled();
		// The bar still shows a runtime and the directory, so those are still read.
		expect(readRuntimeInfo).toHaveBeenCalledTimes(1);
		expect(probe.git).toEqual({ kind: "ok", status: emptyGitStatus() });
	});

	it("starts reading again once a git pill is back on the bar", async () => {
		const { deps, readGitStatus, readGitHost } = readers();

		const probe = await probeProject(
			"/tmp/project",
			configWith(["model", "git"], {
				git: { ...defaultConfig.git, hostIcon: true },
			}),
			deps,
		);

		expect(readGitStatus).toHaveBeenCalledTimes(1);
		expect(readGitStatus).toHaveBeenCalledWith("/tmp/project", {
			readExactTag: false,
			readMetrics: false,
			ignoreSubmodules: defaultConfig.git.metrics.ignoreSubmodules,
		});
		expect(readGitHost).toHaveBeenCalledTimes(1);
		expect(probe.git).toEqual(branchStatus);
		expect(probe.gitHost).toBe("github");
	});

	it("counts every git pill as a reason to read", async () => {
		for (const segment of ["git", "gitCommit", "gitTag", "gitMetrics"]) {
			const { deps, readGitStatus } = readers();
			await probeProject("/tmp/project", configWith([segment]), deps);
			expect(readGitStatus).toHaveBeenCalledTimes(1);
		}
	});

	it("asks for the tag and the metrics the bar shows", async () => {
		const { deps, readGitStatus } = readers();

		await probeProject("/tmp/project", configWith(["gitCommit", "gitMetrics"]), deps);

		expect(readGitStatus).toHaveBeenCalledWith(
			"/tmp/project",
			expect.objectContaining({ readExactTag: true, readMetrics: true }),
		);
	});

	it("asks for a forge icon only when the git pill is on the bar", async () => {
		const withIcon = { git: { ...defaultConfig.git, hostIcon: true } };

		const withGit = readers();
		await probeProject("/tmp/project", configWith(["git"], withIcon), withGit.deps);
		expect(withGit.readGitHost).toHaveBeenCalledTimes(1);

		const withoutGit = readers();
		await probeProject("/tmp/project", configWith(["cwd"], withIcon), withoutGit.deps);
		expect(withoutGit.readGitHost).not.toHaveBeenCalled();
	});

	it("asks the forge for a pull only when its pill is on the bar", async () => {
		const without = readers();
		await probeProject("/tmp/project", configWith(["git"]), without.deps);
		expect(without.readPullSnapshot).not.toHaveBeenCalled();

		const withPill = readers();
		const probe = await probeProject("/tmp/project", configWith(["git", "gitPr"]), withPill.deps);
		expect(withPill.readPullSnapshot).toHaveBeenCalledWith("/tmp/project", "main");
		expect(probe.pull).toEqual({ snapshot: undefined });
	});

	it("has no pull to ask about on a detached HEAD", async () => {
		const detached: GitReadResult = { kind: "ok", status: emptyGitStatus() };
		const { deps, readPullSnapshot } = readers(detached);

		const probe = await probeProject("/tmp/project", configWith(["git", "gitPr"]), deps);

		expect(readPullSnapshot).not.toHaveBeenCalled();
		expect(probe.pull).toEqual({ snapshot: undefined });
	});

	it("reads the project version only when its pill is on the bar", async () => {
		const without = readers();
		await probeProject("/tmp/project", configWith(["cwd"]), without.deps);
		expect(without.readPackageVersion).not.toHaveBeenCalled();

		const withPill = readers();
		const probe = await probeProject(
			"/tmp/project",
			configWith(["cwd", "packageVersion"]),
			withPill.deps,
		);
		expect(withPill.readPackageVersion).toHaveBeenCalledTimes(1);
		expect(probe.packageVersion).toEqual({
			kind: "ok",
			result: { version: "1.2.3", ecosystem: "node" },
		});
	});
});

describe("a refresh with no git pill", () => {
	it("clears the branch and dirty markers the last bar left in state", async () => {
		const state = createInitialState(emptyGitStatus());
		const cwd = "/tmp/project";

		// First refresh: a bar with a git pill.
		const withGit = readers();
		const first = await probeProject(cwd, configWith(["git"]), withGit.deps);
		applyProjectRefreshToState(state, { cwd, previousCwd: undefined, ...first });
		expect(state.branch).toBe("main");
		expect(state.dirty).toBe(true);

		// The user removes the git pill; the reused state object must not keep the branch.
		const withoutGit = readers();
		const second = await probeProject(cwd, configWith(["cwd"]), withoutGit.deps);
		applyProjectRefreshToState(state, { cwd, previousCwd: cwd, ...second });
		expect(withoutGit.readGitStatus).not.toHaveBeenCalled();
		expect(state.branch).toBeUndefined();
		expect(state.dirty).toBe(false);
		expect(state.modified).toBe(0);
	});
});
