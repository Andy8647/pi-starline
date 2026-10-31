import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeRun } from "../extensions/starline/forge-cli";
import type { GitRemote } from "../extensions/starline/git";
import { __resetPullCacheForTests, readPullSnapshot } from "../extensions/starline/pull-probe";

const github: GitRemote = { host: "github", namespace: "owner", name: "repo" };

function remote(host: GitRemote["host"] = "github") {
	return vi.fn(async () => ({ ...github, host }));
}

function gh(answer: string | undefined) {
	return vi.fn<ForgeRun>(async () => answer);
}

const branchAnswer = JSON.stringify([
	{
		number: 9,
		state: "OPEN",
		isDraft: false,
		url: "https://example.test/9",
		statusCheckRollup: [{ conclusion: "SUCCESS" }],
	},
]);

afterEach(() => {
	__resetPullCacheForTests();
});

describe("readPullSnapshot", () => {
	it("keeps its answer for a minute instead of reading on every refresh", async () => {
		const run = gh(branchAnswer);
		const readRemote = remote();
		let now = 1_000;

		const first = await readPullSnapshot("/repo", "main", { run, readRemote, now: () => now });
		now += 30_000;
		const second = await readPullSnapshot("/repo", "main", { run, readRemote, now: () => now });
		now += 40_000;
		const third = await readPullSnapshot("/repo", "main", { run, readRemote, now: () => now });

		expect(first?.branch?.number).toBe(9);
		expect(second).toBe(first);
		expect(third).not.toBe(first);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("reads a different branch without waiting for the window", async () => {
		const run = gh(branchAnswer);
		const readRemote = remote();
		const now = () => 1_000;

		await readPullSnapshot("/repo", "main", { run, readRemote, now });
		await readPullSnapshot("/repo", "feat/x", { run, readRemote, now });

		expect(run).toHaveBeenCalledTimes(2);
	});

	it("keeps the last good answer and backs off while the CLI keeps failing", async () => {
		const readRemote = remote();
		let now = 0;
		const good = gh(branchAnswer);
		const failing = gh(undefined);

		const first = await readPullSnapshot("/repo", "main", {
			run: good,
			readRemote,
			now: () => now,
		});

		now = 61_000;
		const second = await readPullSnapshot("/repo", "main", {
			run: failing,
			readRemote,
			now: () => now,
		});
		expect(second).toBe(first);

		// First failure backs off to two minutes: a read at +90s is still cached.
		now = 61_000 + 90_000;
		await readPullSnapshot("/repo", "main", { run: failing, readRemote, now: () => now });
		expect(failing).toHaveBeenCalledTimes(1);
	});

	it("stops asking a forge it has no CLI for", async () => {
		const run = gh(branchAnswer);
		const readRemote = remote("generic");

		const read = await readPullSnapshot("/repo", "main", { run, readRemote, now: () => 0 });

		expect(read).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("has nothing to show when there is no remote", async () => {
		const run = gh(branchAnswer);
		const readRemote = vi.fn(async () => undefined);

		expect(
			await readPullSnapshot("/repo", "main", { run, readRemote, now: () => 0 }),
		).toBeUndefined();
		expect(run).not.toHaveBeenCalled();
	});

	it("asks the forge for the repository count when the branch has no pull", async () => {
		const run = vi.fn<ForgeRun>(async (command, args) =>
			args.includes("graphql")
				? JSON.stringify({ data: { repository: { pullRequests: { totalCount: 6 } } } })
				: "[]",
		);
		const readRemote = remote();

		const read = await readPullSnapshot("/repo", "main", { run, readRemote, now: () => 0 });

		expect(read).toMatchObject({ host: "github", openCount: 6 });
		expect(read?.branch).toBeUndefined();
	});
});
