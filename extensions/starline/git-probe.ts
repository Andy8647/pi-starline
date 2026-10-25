/**
 * What the bar needs git to read.
 *
 * Every optional probe costs a process: `git tag --points-at` for an exact tag,
 * `git diff HEAD --numstat` for line counts, `git remote -v` for a forge logo.
 * This decides which of them a given segment list asks for, so what is on the
 * bar and what gets read cannot drift apart — the bug that made a `gitTag` pill
 * render empty unless the unrelated `footerSegments.gitCommit` toggle was on.
 *
 * It also answers whether git should be read at all. A bar with no git pill
 * draws nothing from `git status`, so the refresh skip the two processes it
 * would otherwise start every thirty seconds.
 */

export type GitProbeOptions = {
	/** Whether any pill on the bar shows something read from the repository. */
	enabled: boolean;
	/** The pills that show a commit hash want its tag too, when tags are on. */
	readExactTag: boolean;
	readMetrics: boolean;
	readHost: boolean;
};

/** Pills whose content comes from a git read. */
const GIT_SEGMENTS = ["git", "gitCommit", "gitTag", "gitMetrics"] as const;

/** Read options for `readGitStatus` plus the host lookup, from one segment list. */
export function gitProbeOptions(
	segments: readonly string[],
	config: { showTag: boolean; hostIcon: boolean },
): GitProbeOptions {
	const wants = (name: string) => segments.includes(name);
	const wantsCommit = wants("gitCommit");
	return {
		enabled: GIT_SEGMENTS.some(wants),
		readExactTag: wants("gitTag") || (wantsCommit && config.showTag),
		readMetrics: wants("gitMetrics"),
		readHost: wants("git") && config.hostIcon,
	};
}
