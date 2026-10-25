/**
 * The git part of the footer, rendered once.
 *
 * The bar asks for seven strings: branch icon, branch name, dirty-state block,
 * operation label, commit, tag and line metrics. They live here rather than in
 * `footer.ts` so that everything which decides *what a git segment says* — the
 * icon set, the colours, branch length, hash length, counts instead of glyphs —
 * is in one file, and `footer.ts` stays layout.
 */

import type { ColorSource, ColorSpec, PolishedTuiConfig } from "./config";
import { formatGitBranchText, formatGitCommitSegment, formatGitMetricsSegment } from "./format";
import type { GitHost, GitStatusSummary } from "./git";
import type { ResolvedIcons } from "./icons";
import { renderStyleForSource, type ThemeLike } from "./style";

/** The state fields the git segments read. */
export type GitSegmentState = Pick<
	GitStatusSummary,
	| "branch"
	| "ahead"
	| "behind"
	| "conflicted"
	| "untracked"
	| "stashed"
	| "modified"
	| "staged"
	| "renamed"
	| "deleted"
	| "typechanged"
	| "gitStateLabel"
	| "commit"
	| "metrics"
> & { gitHost?: GitHost };

/** The config the git segments read. */
export type GitSegmentConfig = Pick<PolishedTuiConfig, "colors" | "icons" | "git">;

export type GitSegments = {
	/** Branch icon in branch colour; "" when the repository has no branch. */
	icon: string;
	/** Shortened branch name in branch colour; undefined on a detached HEAD. */
	branchText: string | undefined;
	/** `icon branch` as the bar shows it; "" when either part is missing. */
	branch: string;
	/** Dirty-worktree glyphs and ahead/behind in a `[...]` block; "" when clean. */
	status: string;
	/** `REBASING`-style operation label; "" when no operation is in progress. */
	state: string;
	/** Short hash (and tag, when `gitCommit.showTag`), or "" when hidden. */
	commit: string;
	/** The tag on its own, for a `gitTag` segment; "" when there is none. */
	tag: string;
	/** `+added −deleted` line counts; "" when there are none to show. */
	metrics: string;
};

/** Forge logo for the branch segment. Empty in ascii mode, which has no glyphs. */
export function gitHostIconGlyph(icons: ResolvedIcons, host: GitHost): string {
	switch (host) {
		case "github":
			return icons.gitHostGithub;
		case "gitlab":
			return icons.gitHostGitlab;
		case "bitbucket":
			return icons.gitHostBitbucket;
		default:
			return icons.gitHostGeneric;
	}
}

/**
 * Render every git segment.
 *
 * Everything the output depends on — colours, icons, branch length, hash length,
 * counts instead of lone glyphs — comes from `config.git` and `config.colors`.
 */
export function renderGitSegments(
	state: GitSegmentState,
	config: GitSegmentConfig,
	theme: ThemeLike,
	colorSource: ColorSource,
): GitSegments {
	const git = config.git;
	const counts = git.counts;
	const paint = (spec: ColorSpec, text: string) =>
		renderStyleForSource(theme, colorSource, spec, text);
	const icons = config.icons;

	// With git.hostIcon on, the branch icon becomes the origin remote's forge
	// logo. Repos with no origin, and ascii mode (whose host glyphs are all
	// empty), fall back to the plain branch icon.
	const hostGlyph = git.hostIcon && state.gitHost ? gitHostIconGlyph(icons, state.gitHost) : "";
	const glyph = hostGlyph || icons.git;
	const icon = glyph ? paint(config.colors.gitBranch, glyph) : "";

	const branchText = state.branch
		? paint(config.colors.gitBranch, formatGitBranchText(state.branch, git.branch.maxLength))
		: undefined;

	const stashLabel =
		state.stashed > 0 ? (counts ? `${icons.stashed}${state.stashed}` : icons.stashed) : "";
	const dirty = [
		state.conflicted > 0 ? icons.conflicted : "",
		stashLabel,
		state.deleted > 0 ? icons.deleted : "",
		state.renamed > 0 ? icons.renamed : "",
		state.modified > 0 ? icons.modified : "",
		state.typechanged > 0 ? icons.typechanged : "",
		state.staged > 0 ? icons.staged : "",
		state.untracked > 0 ? icons.untracked : "",
	].join("");
	const aheadBehind = (() => {
		if (state.ahead > 0 && state.behind > 0) {
			return counts ? `${icons.ahead}${state.ahead}${icons.behind}${state.behind}` : icons.diverged;
		}
		if (state.ahead > 0) return counts ? `${icons.ahead}${state.ahead}` : icons.ahead;
		if (state.behind > 0) return counts ? `${icons.behind}${state.behind}` : icons.behind;
		return "";
	})();
	const status =
		dirty || aheadBehind ? paint(config.colors.gitStatus, `[${dirty}${aheadBehind}]`) : "";

	const stateLabel = state.gitStateLabel ?? "";
	const operation = stateLabel ? paint(config.colors.gitStatus, stateLabel) : "";

	const commit = formatGitCommitSegment(
		theme,
		state.commit,
		git.commit,
		colorSource,
		config.colors.gitCommit,
	);
	const tag =
		git.commit.showTag && state.commit?.tag ? paint(config.colors.gitCommit, state.commit.tag) : "";
	const metrics = formatGitMetricsSegment(
		theme,
		state.metrics,
		git.metrics,
		colorSource,
		config.colors.gitMetricsAdded,
		config.colors.gitMetricsDeleted,
	);

	return {
		icon,
		branchText,
		branch: branchText ? (icon ? `${icon} ${branchText}` : branchText) : "",
		status,
		state: operation,
		commit,
		tag,
		metrics,
	};
}
