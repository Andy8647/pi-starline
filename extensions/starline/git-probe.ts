/**
 * What the bar needs git to read.
 *
 * Every optional probe costs a process: `git tag --points-at` for an exact tag,
 * `git diff HEAD --numstat` for line counts, `git remote -v` for a forge logo.
 * This decides which of them a given segment list asks for, so what is on the
 * bar and what gets read cannot drift apart — the bug that made a `gitTag` pill
 * render empty unless the unrelated `footerSegments.gitCommit` toggle was on.
 */

export type GitProbeOptions = {
	/** The pills that show a commit hash want its tag too, when tags are on. */
	readExactTag: boolean;
	readMetrics: boolean;
	readHost: boolean;
};

/** Read options for `readGitStatus` plus the host lookup, from one segment list. */
export function gitProbeOptions(
	segments: readonly string[],
	config: { showTag: boolean; hostIcon: boolean },
): GitProbeOptions {
	const wants = (name: string) => segments.includes(name);
	const wantsCommit = wants("gitCommit");
	return {
		readExactTag: wants("gitTag") || (wantsCommit && config.showTag),
		readMetrics: wants("gitMetrics"),
		readHost: wants("git") && config.hostIcon,
	};
}
