/**
 * The pull refresh, with its cache.
 *
 * A forge read is a network call behind a CLI process, which is a different
 * order of cost from `git status`. Two things keep it off the render path:
 *
 * - an answer is kept for a minute, so the thirty-second project refresh only
 *   reaches the forge every other tick;
 * - a failure keeps the last good answer and doubles the wait (up to ten
 *   minutes), so a forge that is down or a laptop off the network costs one
 *   process occasionally instead of two a minute.
 *
 * The remote lookup it needs is already cached per directory by `readGitRemote`.
 */

import { type ForgeRun, forgeSupported, readBranchPull } from "./forge-cli";
import { type GitRemote, readGitRemote } from "./git";
import type { PullSnapshot } from "./pull";

/** A pull changes state on a human timescale; a minute is already chatty. */
const PULL_TTL_MS = 60_000;
/** Backed-off ceiling: a forge that keeps failing is asked this rarely. */
const PULL_TTL_MAX_MS = 10 * 60_000;

type Entry = {
	snapshot: PullSnapshot | undefined;
	expiresAt: number;
	failures: number;
};

const pullCache = new Map<string, Entry>();

function cacheKey(cwd: string, branch: string): string {
	return `${cwd}\u0000${branch}`;
}

export type PullSnapshotReadOptions = {
	/** Injected in tests; production uses the real CLIs. */
	run?: ForgeRun;
	/** Injected in tests, so a cache window can be crossed without waiting. */
	now?: () => number;
	/** Injected in tests; production resolves the remote through git. */
	readRemote?: (cwd: string) => Promise<GitRemote | undefined>;
};

/**
 * The pull for `branch`, or the repository's open count when the branch has
 * none. `undefined` means there is nothing to show (no remote, an unsupported
 * forge, or a read that has never succeeded).
 */
export async function readPullSnapshot(
	cwd: string,
	branch: string,
	options: PullSnapshotReadOptions = {},
): Promise<PullSnapshot | undefined> {
	const now = options.now?.() ?? Date.now();
	const key = cacheKey(cwd, branch);
	const cached = pullCache.get(key);
	if (cached && cached.expiresAt > now) return cached.snapshot;

	const remote = await (options.readRemote ?? readGitRemote)(cwd);
	if (!remote || !forgeSupported(remote.host)) {
		// Nothing to ask: park the answer for the full window rather than retrying.
		pullCache.set(key, { snapshot: undefined, expiresAt: now + PULL_TTL_MAX_MS, failures: 0 });
		return undefined;
	}

	const read = await readBranchPull(cwd, remote, branch, options.run);
	if (!read) {
		const failures = (cached?.failures ?? 0) + 1;
		const backoff = Math.min(PULL_TTL_MS * 2 ** failures, PULL_TTL_MAX_MS);
		pullCache.set(key, { snapshot: cached?.snapshot, expiresAt: now + backoff, failures });
		return cached?.snapshot;
	}

	const snapshot: PullSnapshot = {
		host: remote.host,
		branch: read.pull,
		openCount: read.openCount,
	};
	pullCache.set(key, { snapshot, expiresAt: now + PULL_TTL_MS, failures: 0 });
	return snapshot;
}

/** Drop the cached snapshots, for tests and for a session that changed directory. */
export function __resetPullCacheForTests(): void {
	pullCache.clear();
}
