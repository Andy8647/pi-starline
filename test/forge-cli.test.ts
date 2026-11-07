import { describe, expect, it } from "vitest";
import {
	checksFromGithubRollup,
	type ForgeRun,
	openCountFromGithubGraphql,
	openCountFromGitlabGraphql,
	pickBranchPull,
	pullFromGithub,
	pullFromGitlab,
	pullListsFromGithubGraphql,
	pullStateFromGithub,
	readBranchPull,
	readForgeLists,
	readUserPulls,
	reviewFromGithub,
} from "../extensions/starline/forge-cli";
import type { GitRemote } from "../extensions/starline/git";
import type { Pull } from "../extensions/starline/pull";

const github: GitRemote = {
	host: "github",
	namespace: "owner",
	name: "repo",
	webUrl: "https://github.com/owner/repo",
};
const gitlab: GitRemote = {
	host: "gitlab",
	namespace: "group/sub",
	name: "repo",
	webUrl: "https://gitlab.com/group/sub/repo",
};

function runner(answers: Array<string | undefined>) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run: ForgeRun = async (command, args) => {
		calls.push({ command, args });
		return answers.shift();
	};
	return { run, calls };
}

function pull(overrides: Partial<Pull> = {}): Pull {
	return { number: 7, state: "open", url: "https://example.test/7", ...overrides };
}

describe("GitHub JSON mapping", () => {
	it("reads the state and the draft flag", () => {
		expect(pullStateFromGithub("OPEN", false)).toBe("open");
		expect(pullStateFromGithub("OPEN", true)).toBe("draft");
		expect(pullStateFromGithub("MERGED", false)).toBe("merged");
		expect(pullStateFromGithub("CLOSED", true)).toBe("closed");
	});

	it("rolls checks up to the worst thing in the list", () => {
		expect(checksFromGithubRollup([])).toBeUndefined();
		expect(checksFromGithubRollup(undefined)).toBeUndefined();
		expect(checksFromGithubRollup([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe(
			"passing",
		);
		expect(checksFromGithubRollup([{ conclusion: "SUCCESS" }, { conclusion: null }])).toBe(
			"pending",
		);
		expect(checksFromGithubRollup([{ conclusion: "SUCCESS" }, { state: "FAILURE" }])).toBe(
			"failing",
		);
		expect(checksFromGithubRollup([{ conclusion: "TIMED_OUT" }])).toBe("failing");
	});

	it("reads the review decision", () => {
		expect(reviewFromGithub("APPROVED")).toBe("approved");
		expect(reviewFromGithub("CHANGES_REQUESTED")).toBe("changes");
		expect(reviewFromGithub("REVIEW_REQUIRED")).toBe("required");
		expect(reviewFromGithub("")).toBeUndefined();
	});

	it("maps one pull, and only reads checks when asked", () => {
		const raw = {
			number: 7,
			state: "OPEN",
			isDraft: false,
			url: "https://example.test/7",
			title: "Add the thing",
			reviewDecision: "APPROVED",
			statusCheckRollup: [{ conclusion: "SUCCESS" }],
		};

		expect(pullFromGithub(raw)).toEqual({
			number: 7,
			state: "open",
			url: "https://example.test/7",
			title: "Add the thing",
		});
		expect(pullFromGithub(raw, true)).toMatchObject({ checks: "passing", review: "approved" });
	});

	it("ignores a node without a number or a url", () => {
		expect(pullFromGithub({ state: "OPEN" })).toBeUndefined();
		expect(pullFromGithub(undefined)).toBeUndefined();
	});

	it("prefers the live pull when a branch has several", () => {
		expect(pickBranchPull([pull({ state: "merged" }), pull({ state: "open", number: 9 })])).toEqual(
			pull({ state: "open", number: 9 }),
		);
		expect(pickBranchPull([pull({ state: "merged" })])).toEqual(pull({ state: "merged" }));
		expect(pickBranchPull([])).toBeUndefined();
	});

	it("reads the open count out of the GraphQL answer", () => {
		expect(
			openCountFromGithubGraphql({
				data: { repository: { pullRequests: { totalCount: 3 } } },
			}),
		).toBe(3);
		expect(openCountFromGithubGraphql({ data: {} })).toBeUndefined();
		expect(openCountFromGitlabGraphql({ data: { project: { mergeRequests: { count: 2 } } } })).toBe(
			2,
		);
	});

	it("splits the three search groups", () => {
		const lists = pullListsFromGithubGraphql({
			data: {
				authored: { nodes: [{ number: 1, state: "OPEN", url: "u1" }] },
				reviewing: { nodes: [{ number: 2, state: "OPEN", url: "u2" }] },
				involved: { nodes: [] },
			},
		});

		expect(lists.authored).toHaveLength(1);
		expect(lists.reviewing[0]?.number).toBe(2);
		expect(lists.involved).toEqual([]);
	});

	it("maps a GitLab merge request, nested namespace and all", () => {
		expect(
			pullFromGitlab({ iid: 12, state: "opened", draft: true, web_url: "g/12", title: "MR" }),
		).toEqual({ number: 12, state: "draft", url: "g/12", title: "MR" });
		expect(pullFromGitlab({ iid: 12, state: "merged", web_url: "g/12" })).toMatchObject({
			state: "merged",
		});
		expect(pullFromGitlab({ state: "opened" })).toBeUndefined();
	});
});

describe("readBranchPull", () => {
	const ghList = (nodes: unknown[]) => JSON.stringify(nodes);

	it("asks gh for the branch and returns its pull", async () => {
		const { run, calls } = runner([ghList([{ number: 5, state: "OPEN", url: "u5" }])]);

		const read = await readBranchPull("/repo", github, "feat/x", run);

		expect(read?.pull).toEqual({ number: 5, state: "open", url: "u5", title: undefined });
		expect(calls[0]?.command).toBe("gh");
		expect(calls[0]?.args).toContain("--head");
		expect(calls[0]?.args).toContain("feat/x");
	});

	it("falls back to the repository's open count when the branch has no pull", async () => {
		const { run, calls } = runner([
			ghList([]),
			JSON.stringify({ data: { repository: { pullRequests: { totalCount: 4 } } } }),
		]);

		const read = await readBranchPull("/repo", github, "main", run);

		expect(read).toEqual({ openCount: 4 });
		expect(calls[1]?.args).toContain("graphql");
	});

	it("returns undefined when the CLI fails, so the caller keeps its last answer", async () => {
		const { run } = runner([undefined]);

		expect(await readBranchPull("/repo", github, "main", run)).toBeUndefined();
	});

	it("does not ask a forge it has no CLI for", async () => {
		const { run, calls } = runner([]);

		expect(
			await readBranchPull(
				"/repo",
				{ host: "generic", namespace: "a", name: "b", webUrl: "https://git.example.test/a/b" },
				"main",
				run,
			),
		).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("asks glab for a GitLab merge request", async () => {
		const { run, calls } = runner([JSON.stringify([{ iid: 3, state: "opened", web_url: "g/3" }])]);

		const read = await readBranchPull("/repo", gitlab, "feat/y", run);

		expect(read?.pull).toEqual({ number: 3, state: "open", url: "g/3", title: undefined });
		expect(calls[0]?.command).toBe("glab");
		expect(calls[0]?.args).toContain("--source-branch");
	});
});

describe("readUserPulls", () => {
	it("reads GitHub's three groups in one request", async () => {
		const { run, calls } = runner([
			JSON.stringify({
				data: {
					authored: { nodes: [{ number: 1, state: "OPEN", url: "u1" }] },
					reviewing: { nodes: [] },
					involved: { nodes: [] },
				},
			}),
		]);

		const lists = await readUserPulls("/repo", github, run);

		expect(calls).toHaveLength(1);
		expect(lists?.authored[0]?.number).toBe(1);
	});

	it("asks only for open pulls", async () => {
		const { run, calls } = runner([JSON.stringify({ data: {} })]);

		await readUserPulls("/repo", github, run);

		expect(calls[0]?.args.join(" ")).toContain("is:open");
	});

	it("keeps merged and closed pulls off the list even when the forge returns them", async () => {
		const { run } = runner([
			JSON.stringify({
				data: {
					authored: {
						nodes: [
							{ number: 1, state: "OPEN", url: "u1" },
							{ number: 2, state: "MERGED", url: "u2" },
							{ number: 3, state: "CLOSED", url: "u3" },
						],
					},
					reviewing: { nodes: [] },
					involved: { nodes: [] },
				},
			}),
		]);

		const lists = await readUserPulls("/repo", github, run);

		expect(lists?.authored.map((pull) => pull.number)).toEqual([1]);
	});

	it("reads GitLab's three groups as three list calls", async () => {
		const { run, calls } = runner([
			JSON.stringify([{ iid: 1, state: "opened", web_url: "g/1" }]),
			JSON.stringify([]),
			JSON.stringify([]),
		]);

		const lists = await readUserPulls("/repo", gitlab, run);

		expect(calls).toHaveLength(3);
		expect(lists?.authored[0]?.number).toBe(1);
	});

	it("gives up when every GitLab call failed", async () => {
		const { run } = runner([undefined, undefined, undefined]);

		expect(await readUserPulls("/repo", gitlab, run)).toBeUndefined();
	});

	it("lists a pull once when GitHub's searches overlap", async () => {
		// The search excludes authored and review-requested pulls from `involves`,
		// but it does not always honour its own exclusions.
		const { run } = runner([
			JSON.stringify({
				data: {
					authored: { nodes: [{ number: 7, state: "OPEN", url: "same" }] },
					reviewing: { nodes: [] },
					involved: { nodes: [{ number: 7, state: "OPEN", url: "same" }] },
				},
			}),
		]);

		const lists = await readUserPulls("/repo", github, run);

		expect(lists?.authored.map((pull) => pull.number)).toEqual([7]);
		expect(lists?.involved).toEqual([]);
	});

	it("lists a merge request once when GitLab's reviewer and assignee lists overlap", async () => {
		const { run } = runner([
			JSON.stringify([]),
			JSON.stringify([{ iid: 7, state: "opened", web_url: "same" }]),
			JSON.stringify([{ iid: 7, state: "opened", web_url: "same" }]),
		]);

		const lists = await readUserPulls("/repo", gitlab, run);

		expect(lists?.reviewing.map((pull) => pull.number)).toEqual([7]);
		expect(lists?.involved).toEqual([]);
	});
});

describe("readForgeLists with issues", () => {
	const issueNode = (number: number) => ({
		number,
		title: `Issue ${number}`,
		url: `https://github.com/owner/repo/issues/${number}`,
	});

	/** One GitHub answer carrying both the pull and the issue aliases. */
	function githubAnswer(
		overrides: {
			assigned?: unknown[];
			authored?: unknown[];
			other?: unknown[];
			openCount?: number;
			hasIssuesEnabled?: boolean;
		} = {},
	): string {
		const group = (nodes: unknown[], issueCount = nodes.length) => ({ issueCount, nodes });
		return JSON.stringify({
			data: {
				authored: { nodes: [] },
				reviewing: { nodes: [] },
				involved: { nodes: [] },
				issuesAssigned: group(overrides.assigned ?? []),
				issuesAuthored: group(overrides.authored ?? []),
				issuesOther: group(overrides.other ?? []),
				issuesAll: group([], overrides.openCount ?? 0),
				repository: { hasIssuesEnabled: overrides.hasIssuesEnabled ?? true },
			},
		});
	}

	it("leaves the query byte for byte alone when issues are off", async () => {
		const withIssues = runner([githubAnswer()]);
		const withoutIssues = runner([githubAnswer()]);

		await readForgeLists("/repo", github, { issues: true }, withIssues.run);
		await readUserPulls("/repo", github, withoutIssues.run);

		expect(withoutIssues.calls[0]?.args.join(" ")).not.toContain("is:issue");
		expect(withIssues.calls[0]?.args.join(" ")).toContain("is:issue is:open assignee:@me");
	});

	it("counts open issues with a search, not the repository's issue connection", async () => {
		// `repository.issues` includes pull requests, which would report a busy repo
		// as having hundreds more issues than it does.
		const { run, calls } = runner([githubAnswer()]);

		await readForgeLists("/repo", github, { issues: true }, run);

		const query = calls[0]?.args.join(" ") ?? "";
		expect(query).toContain("issuesAll:search");
		expect(query).not.toContain("issues(states");
	});

	it("lists the groups with the counts the forge reported", async () => {
		const { run } = runner([
			githubAnswer({ assigned: [issueNode(1), issueNode(2)], openCount: 4 }),
		]);

		const lists = await readForgeLists("/repo", github, { issues: true }, run);

		expect(lists?.issues).toMatchObject({
			enabled: true,
			openCount: 4,
			assigned: { total: 2 },
			other: { total: 0 },
		});
	});

	it("drops the backlog rows above the threshold but keeps the count", async () => {
		const other = Array.from({ length: 8 }, (_, index) => issueNode(index + 10));
		const { run } = runner([githubAnswer({ other, openCount: 21 })]);

		const lists = await readForgeLists("/repo", github, { issues: true }, run);

		expect(lists?.issues).toMatchObject({ openCount: 21 });
		if (!lists?.issues || lists.issues === "failed") throw new Error("expected issues");
		expect(lists.issues.other.items).toEqual([]);
		expect(lists.issues.other.total).toBe(8);
	});

	it("keeps the backlog rows at the threshold", async () => {
		const other = [issueNode(10), issueNode(11)];
		const { run } = runner([githubAnswer({ other, openCount: 20 })]);

		const lists = await readForgeLists("/repo", github, { issues: true }, run);

		if (!lists?.issues || lists.issues === "failed") throw new Error("expected issues");
		expect(lists.issues.other.items.map((issue) => issue.number)).toEqual([10, 11]);
	});

	it("lists an issue once when the searches overlap", async () => {
		// `-assignee:@me -author:@me` is not always honoured, the same way the pull
		// searches are not.
		const shared = issueNode(5);
		const { run } = runner([
			githubAnswer({ assigned: [shared], authored: [shared], other: [shared], openCount: 3 }),
		]);

		const lists = await readForgeLists("/repo", github, { issues: true }, run);

		if (!lists?.issues || lists.issues === "failed") throw new Error("expected issues");
		expect(lists.issues.authored.items).toEqual([]);
		expect(lists.issues.other.items).toEqual([]);
	});

	it("hides the section when the repository has issues turned off", async () => {
		const { run } = runner([githubAnswer({ hasIssuesEnabled: false })]);

		const lists = await readForgeLists("/repo", github, { issues: true }, run);

		if (!lists?.issues || lists.issues === "failed") throw new Error("expected issues");
		expect(lists.issues.enabled).toBe(false);
	});

	it("skips the backlog on a GitLab repository that is too big to list", async () => {
		// Three merge-request lists, then the count, then the two groups it can show.
		const { run, calls } = runner([
			JSON.stringify([]),
			JSON.stringify([]),
			JSON.stringify([]),
			JSON.stringify({ data: { project: { issuesEnabled: true, issues: { count: 300 } } } }),
			JSON.stringify([{ iid: 1, title: "g1", web_url: "g/1" }]),
			JSON.stringify([]),
		]);

		const lists = await readForgeLists("/repo", gitlab, { issues: true }, run);

		expect(calls).toHaveLength(6);
		if (!lists?.issues || lists.issues === "failed") throw new Error("expected issues");
		expect(lists.issues.other.items).toEqual([]);
		expect(lists.issues.assigned.items[0]?.number).toBe(1);
	});

	it("still shows the pulls when only the issue read failed", async () => {
		// The count answered, both groups failed: the pulls are unaffected.
		const { run } = runner([
			JSON.stringify([{ iid: 3, state: "opened", web_url: "g/3" }]),
			JSON.stringify([]),
			JSON.stringify([]),
			JSON.stringify({ data: { project: { issuesEnabled: true, issues: { count: 1 } } } }),
			undefined,
			undefined,
		]);

		const lists = await readForgeLists("/repo", gitlab, { issues: true }, run);

		expect(lists?.pulls.authored[0]?.number).toBe(3);
		expect(lists?.issues).toBe("failed");
	});
});
