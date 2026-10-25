import { describe, expect, it } from "vitest";
import { mergeConfig } from "../extensions/starline/config";
import { emptyGitStatus } from "../extensions/starline/git";
import { type GitSegmentState, renderGitSegments } from "../extensions/starline/git-segments";
import type { ThemeLike } from "../extensions/starline/style";

/** Colours are not what these tests are about, so the theme adds none. */
const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const icons = {
	git: "G",
	stashed: "S",
	conflicted: "!",
	deleted: "D",
	renamed: "R",
	modified: "M",
	typechanged: "T",
	staged: "A",
	untracked: "?",
	ahead: "^",
	behind: "v",
	diverged: "X",
	gitHostGithub: "GH",
	gitHostGitlab: "GL",
	gitHostBitbucket: "BB",
	gitHostGeneric: "GT",
};

const config = (patch: Record<string, unknown> = {}) => mergeConfig({ icons, ...patch });

const state = (patch: Partial<GitSegmentState> = {}): GitSegmentState => ({
	...emptyGitStatus(),
	...patch,
});

const render = (gitState: GitSegmentState, patch: Record<string, unknown> = {}) =>
	renderGitSegments(gitState, config(patch), theme, "theme");

describe("branch", () => {
	it("paints the icon before the branch name", () => {
		const git = render(state({ branch: "main" }));
		expect(git.icon).toBe("G");
		expect(git.branchText).toBe("main");
		expect(git.branch).toBe("G main");
	});

	it("has nothing to show on a detached HEAD", () => {
		const git = render(state({ branch: undefined }));
		expect(git.branchText).toBeUndefined();
		expect(git.branch).toBe("");
	});

	it("swaps the branch glyph for the origin's forge logo when gitHostIcon is on", () => {
		const git = render(state({ branch: "main", gitHost: "github" }), { git: { hostIcon: true } });
		expect(git.icon).toBe("GH");
		expect(git.branch).toBe("GH main");
	});

	it("keeps the branch glyph when the toggle is off, however the remote looks", () => {
		const git = render(state({ branch: "main", gitHost: "github" }), { git: { hostIcon: false } });
		expect(git.icon).toBe("G");
	});
});

describe("status", () => {
	it("is empty when the worktree is clean and level with the remote", () => {
		expect(render(state({ branch: "main" })).status).toBe("");
	});

	it("lists one glyph per kind of change, in a fixed order", () => {
		const git = render(
			state({ branch: "main", modified: 2, untracked: 1, staged: 1, conflicted: 1 }),
		);
		expect(git.status).toBe("[!MA?]");
	});

	it("shows counts instead of lone glyphs when `counts` is on", () => {
		const dirty = state({ branch: "main", stashed: 2, ahead: 3, behind: 1 });
		expect(render(dirty).status).toBe("[SX]");
		expect(render(dirty, { git: { counts: true } }).status).toBe("[S2^3v1]");
	});
});

describe("operation state and commit", () => {
	it("renders the operation label on its own", () => {
		expect(render(state({ branch: "main", gitStateLabel: "REBASING" })).state).toBe("REBASING");
	});

	it("shows the short hash, and the tag only when showTag is on", () => {
		const commit = { oid: "abcdef1234", detached: true, tag: "v1.2.3" };
		expect(render(state({ commit })).commit).toBe("abcdef1 v1.2.3");
		expect(render(state({ commit })).tag).toBe("v1.2.3");
		expect(render(state({ commit }), { git: { commit: { showTag: false } } }).tag).toBe("");
	});

	it("hides the commit while attached when onlyDetached is on", () => {
		const commit = { oid: "abcdef1234", detached: false, tag: null };
		expect(render(state({ commit })).commit).toBe("");
		expect(render(state({ commit }), { git: { commit: { onlyDetached: false } } }).commit).toBe(
			"abcdef1",
		);
	});
});

describe("metrics", () => {
	it("renders added and deleted together", () => {
		expect(render(state({ metrics: { added: 12, deleted: 3 } })).metrics).toBe("+12 −3");
	});

	it("drops a zero side by default", () => {
		const metrics = { added: 0, deleted: 4 };
		expect(render(state({ metrics })).metrics).toBe("−4");
		expect(render(state({ metrics }), { git: { metrics: { onlyNonzero: false } } }).metrics).toBe(
			"+0 −4",
		);
	});

	it("is empty without metrics to show", () => {
		expect(render(state({ metrics: undefined })).metrics).toBe("");
	});
});
