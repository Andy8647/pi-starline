import { afterEach, describe, expect, it } from "vitest";
import { emptyGitStatus, type GitStatusSummary } from "../extensions/starline/git";
import { setActiveGitStatus } from "../extensions/starline/git-live";
import { gitBubbleContent, pillActionFor } from "../extensions/starline/pill-actions";

const status = (patch: Partial<GitStatusSummary> = {}): GitStatusSummary => ({
	...emptyGitStatus(),
	...patch,
});

afterEach(() => setActiveGitStatus(undefined));

describe("git pill", () => {
	it("has an action, so a click opens the bubble instead of falling through", () => {
		expect(pillActionFor("git")).toBeTypeOf("function");
	});

	it("says nothing is changed when the tree is clean", () => {
		setActiveGitStatus(status({ branch: "main" }));
		const content = gitBubbleContent();
		expect(content.title).toBe("main");
		expect(content.body).toEqual(["Working tree clean."]);
	});

	it("lists changed paths, staged kinds first, and counts them in the title", () => {
		setActiveGitStatus(
			status({
				branch: "main",
				changes: [
					{ code: "?", path: "notes.md" },
					{ code: "M", path: "src/app.ts" },
					{ code: "A", path: "src/new.ts" },
				],
			}),
		);
		const content = gitBubbleContent();
		expect(content.title).toBe("main · 3 changed");
		expect(content.body).toEqual([
			"modified · src/app.ts",
			"added · src/new.ts",
			"untracked · notes.md",
		]);
	});

	it("summarises the paths past the twelfth", () => {
		setActiveGitStatus(
			status({
				branch: "main",
				changes: Array.from({ length: 14 }, (_, index) => ({
					code: "M",
					path: `file-${index}.ts`,
				})),
			}),
		);
		const body = gitBubbleContent().body;
		expect(body).toHaveLength(13);
		expect(body.at(-1)).toBe("+2 more");
	});

	it("reports ahead, behind and stashes above the file list", () => {
		setActiveGitStatus(
			status({
				branch: "main",
				ahead: 2,
				behind: 1,
				stashed: 1,
				changes: [{ code: "M", path: "a.ts" }],
			}),
		);
		expect(gitBubbleContent().body).toEqual(["2 ahead, 1 behind", "1 stash", "modified · a.ts"]);
	});

	it("names the detached HEAD and the operation in progress", () => {
		setActiveGitStatus(
			status({
				commit: { oid: "abc1234", detached: true, tag: null },
				gitStateLabel: "REBASING",
			}),
		);
		const content = gitBubbleContent();
		expect(content.title).toBe("HEAD");
		expect(content.body).toEqual(["Operation: REBASING"]);
	});

	it("says so when nothing has been read yet", () => {
		expect(gitBubbleContent().body).toEqual(["No repository in this project."]);
	});
});
