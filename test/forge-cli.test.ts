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
	readUserPulls,
	reviewFromGithub,
} from "../extensions/starline/forge-cli";
import type { GitRemote } from "../extensions/starline/git";
import type { Pull } from "../extensions/starline/pull";

const github: GitRemote = { host: "github", namespace: "owner", name: "repo" };
const gitlab: GitRemote = { host: "gitlab", namespace: "group/sub", name: "repo" };

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
			await readBranchPull("/repo", { host: "generic", namespace: "a", name: "b" }, "main", run),
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
});
