/**
 * One project refresh's reads: git, the runtime in this directory, and the
 * project's own version.
 *
 * Kept out of the extension entry so a test can hand it fake readers and see
 * which of them a given bar actually asks for — the question "does a bar with
 * no git pill still run `git status`?" is not answerable from a closure.
 *
 * The readers are injected rather than imported at the call site for exactly
 * that reason; production passes the real ones.
 */

import type { PolishedTuiConfig } from "./config";
import {
	emptyGitStatus,
	type GitHost,
	type GitReadResult,
	readGitHost,
	readGitStatus,
} from "./git";
import { gitProbeOptions } from "./git-probe";
import { readPublishedVersionForCwd } from "./package-summary";
import { type PackageVersionReadResult, readPackageVersionResult } from "./package-version";
import type { PullSnapshot } from "./pull";
import { type RuntimeReadResult, readRuntimeInfo } from "./runtime";

export type ProjectProbe = {
	git: GitReadResult;
	/** Undefined when the bar does not ask for a forge icon: keep the last one. */
	gitHost: GitHost | undefined;
	runtime: RuntimeReadResult;
	/** Undefined when the bar does not show the project version. */
	packageVersion: PackageVersionReadResult | undefined;
	/**
	 * What the registry has as `latest`, which is the version the pill shows.
	 * Undefined when the bar does not show the project version, or when this is
	 * not a package the registry knows.
	 */
	publishedVersion?: string;
	/**
	 * The pull for the current branch, wrapped so "not asked for" and "no pull
	 * here" are different things: undefined means keep the last answer, a
	 * `snapshot` of undefined means the pill has nothing to draw.
	 */
	pull: { snapshot: PullSnapshot | undefined } | undefined;
};

export type ProjectProbeReaders = {
	readGitStatus: typeof readGitStatus;
	readGitHost: typeof readGitHost;
	readPullSnapshot: (cwd: string, branch: string) => Promise<PullSnapshot | undefined>;
	readRuntimeInfo: typeof readRuntimeInfo;
	readPackageVersion: typeof readPackageVersionResult;
	readPublishedVersion: typeof readPublishedVersionForCwd;
};

import { readPullSnapshot } from "./pull-probe";

const REAL_READERS: ProjectProbeReaders = {
	readGitStatus,
	readGitHost,
	readPullSnapshot,
	readRuntimeInfo,
	readPackageVersion: readPackageVersionResult,
	readPublishedVersion: readPublishedVersionForCwd,
};

/**
 * Read what the bar is about to draw, in parallel.
 *
 * A bar with no git pill gets an empty status instead of a read, which also
 * clears the branch and dirty markers the previous bar left in state — the
 * object is reused across refreshes, so skipping the read must not mean keeping
 * yesterday's branch.
 */
export async function probeProject(
	cwd: string,
	config: PolishedTuiConfig,
	readers: ProjectProbeReaders = REAL_READERS,
): Promise<ProjectProbe> {
	const probe = gitProbeOptions(config.pill.segments, {
		showTag: config.git.commit.showTag,
		hostIcon: config.git.hostIcon,
	});
	const wantPackage = config.pill.segments.includes("packageVersion");
	const wantPull = config.pill.segments.includes("gitPr");
	const [git, runtime, packageVersion, published, gitHost] = await Promise.all([
		probe.enabled
			? readers.readGitStatus(cwd, {
					readExactTag: probe.readExactTag,
					readMetrics: probe.readMetrics,
					ignoreSubmodules: config.git.metrics.ignoreSubmodules,
				})
			: Promise.resolve<GitReadResult>({ kind: "ok", status: emptyGitStatus() }),
		readers.readRuntimeInfo(cwd),
		wantPackage ? readers.readPackageVersion(cwd) : Promise.resolve(undefined),
		// The pill shows what the registry has, so the registry is what it asks. The
		// read is cached per directory: a refresh every 30 seconds is one request.
		wantPackage ? readers.readPublishedVersion(cwd) : Promise.resolve(undefined),
		probe.readHost ? readers.readGitHost(cwd) : Promise.resolve(undefined),
	]);
	// The branch comes out of the git read above, so the forge read cannot run
	// beside it. A detached HEAD has no branch to ask about and clears the pill.
	const branch = git.kind === "ok" ? git.status.branch : undefined;
	const pull = !wantPull
		? undefined
		: { snapshot: branch ? await readers.readPullSnapshot(cwd, branch) : undefined };
	return { git, gitHost, runtime, packageVersion, publishedVersion: published?.version, pull };
}
