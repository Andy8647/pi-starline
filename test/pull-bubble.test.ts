import { describe, expect, it } from "vitest";
import type { IssueLists, Pull, PullLists } from "../extensions/starline/pull";
import { pullBubbleBody } from "../extensions/starline/pull-bubble";

/**
 * The bubble's rows for one forge answer. The repository row is the way into
 * the repo's page, so it is there whatever the lists say — and the URL never
 * becomes visible text.
 */

function pull(number: number): Pull {
	return {
		number,
		state: "open",
		url: `https://github.com/owner/repo/pull/${number}`,
		title: `Pr ${number}`,
	};
}

function lists(overrides: Partial<PullLists> = {}): PullLists {
	return { authored: [], reviewing: [], involved: [], ...overrides };
}

const REPO_ROW = "↗ Open repository";
const REPO_URL = "https://github.com/owner/repo";

function texts(body: ReturnType<typeof pullBubbleBody>): string[] {
	return body.map((line) => (typeof line === "string" ? line : line.text));
}

describe("pullBubbleBody", () => {
	it("keeps the repository row under the three groups", () => {
		const body = texts(pullBubbleBody(lists({ authored: [pull(1), pull(2)] }), "#", REPO_URL));
		expect(body).toEqual(["Yours · 2", "#1 Pr 1 · open", "#2 Pr 2 · open", REPO_ROW]);
	});

	it("keeps the repository row when the user has nothing", () => {
		expect(texts(pullBubbleBody(lists(), "#", REPO_URL))).toEqual([
			"Nothing authored, requested for review, or involved.",
			REPO_ROW,
		]);
	});

	it("keeps the repository row while the forge is still reading", () => {
		expect(texts(pullBubbleBody(undefined, "#", REPO_URL))).toEqual([
			"Reading from the forge…",
			REPO_ROW,
		]);
	});

	it("has no row without a remote to open", () => {
		expect(texts(pullBubbleBody(lists(), "#", undefined))).toEqual([
			"Nothing authored, requested for review, or involved.",
		]);
	});

	it("never puts the URL in the bubble text", () => {
		const body = pullBubbleBody(lists({ authored: [pull(1)] }), "!", REPO_URL);
		const shown = texts(body).join("\n");
		expect(shown).not.toContain(REPO_URL);
		expect(shown).toContain(REPO_ROW);
	});

	it("opens the repository from its own row", () => {
		const body = pullBubbleBody(lists(), "#", REPO_URL);
		const row = body.at(-1);
		expect(typeof row).toBe("object");
		expect(typeof (row as { onSelect: () => void }).onSelect).toBe("function");
	});
});

describe("issues in the pull bubble", () => {
	function issue(number: number) {
		return {
			number,
			title: `Issue ${number}`,
			url: `https://github.com/owner/repo/issues/${number}`,
		};
	}

	function issueLists(overrides: Partial<IssueLists> = {}): IssueLists {
		return {
			enabled: true,
			openCount: 2,
			assigned: { items: [issue(1)], total: 1 },
			authored: { items: [issue(2)], total: 1 },
			other: { items: [], total: 0 },
			...overrides,
		};
	}

	it("leaves the bubble exactly as it was when issues are off", () => {
		const off = texts(pullBubbleBody(lists(), "#", REPO_URL));
		const on = texts(pullBubbleBody(lists(), "#", REPO_URL, { issues: undefined }));

		expect(on).toEqual(off);
		expect(on.join("\n")).not.toContain("issue");
	});

	it("lists the issue groups under the pull groups", () => {
		const body = texts(
			pullBubbleBody(lists({ authored: [pull(1)] }), "#", REPO_URL, {
				issues: issueLists(),
				issuesUrl: `${REPO_URL}/issues`,
			}),
		);

		expect(body).toEqual([
			"Yours · 1",
			"#1 Pr 1 · open",
			"Assigned to you · 1",
			"#1 Issue 1",
			"You opened · 1",
			"#2 Issue 2",
			REPO_ROW,
		]);
	});

	it("collapses a large backlog to one counted row", () => {
		const body = texts(
			pullBubbleBody(lists(), "#", REPO_URL, {
				issues: issueLists({
					openCount: 8412,
					assigned: { items: [], total: 0 },
					authored: { items: [], total: 0 },
				}),
				issuesUrl: `${REPO_URL}/issues`,
			}),
		);

		expect(body).toContain("↗ All 8412 open issues");
		expect(body).not.toContain("Other open issues · 0");
	});

	it("keeps the backlog rows while the repository is small", () => {
		const body = texts(
			pullBubbleBody(lists(), "#", REPO_URL, {
				issues: issueLists({ openCount: 20, other: { items: [issue(9)], total: 1 } }),
				issuesUrl: `${REPO_URL}/issues`,
			}),
		);

		expect(body).toContain("Other open issues · 1");
		expect(body).not.toContain("↗ All 20 open issues");
	});

	it("opens the issue list from the counted row", () => {
		const body = pullBubbleBody(lists(), "#", REPO_URL, {
			issues: issueLists({ openCount: 500, assigned: { items: [], total: 0 } }),
			issuesUrl: `${REPO_URL}/issues`,
		});
		const row = body.find(
			(line) => typeof line === "object" && line.text.startsWith("↗ All 500"),
		) as { onSelect: () => void } | undefined;

		expect(typeof row?.onSelect).toBe("function");
	});

	it("says the issues could not be read rather than showing none", () => {
		const body = texts(
			pullBubbleBody(lists({ authored: [pull(1)] }), "#", REPO_URL, { issues: "failed" }),
		);

		expect(body).toContain("Issues unavailable");
		expect(body).toContain("Yours · 1");
	});

	it("hides the section when the repository has no issue tracker", () => {
		const body = texts(
			pullBubbleBody(lists(), "#", REPO_URL, {
				issues: issueLists({ enabled: false, assigned: { items: [], total: 0 } }),
				issuesUrl: `${REPO_URL}/issues`,
			}),
		);

		expect(body.join("\n")).not.toContain("Issue");
	});

	it("says a read failed instead of reading forever", () => {
		expect(texts(pullBubbleBody("failed", "#", REPO_URL))).toEqual([
			"Could not read from the forge.",
			REPO_ROW,
		]);
	});

	it("shortens the list to the rows the terminal has, and says by how much", () => {
		const many = Array.from({ length: 8 }, (_, index) => pull(index + 1));
		const body = texts(pullBubbleBody(lists({ authored: many }), "#", REPO_URL, { maxRows: 4 }));

		// Four rows for the sections: one heading plus three pulls.
		expect(body).toEqual([
			"Yours · 3 of 8",
			"#1 Pr 1 · open",
			"#2 Pr 2 · open",
			"#3 Pr 3 · open",
			REPO_ROW,
		]);
	});

	it("takes rows from the last section first", () => {
		const many = Array.from({ length: 3 }, (_, index) => pull(index + 1));
		const body = texts(
			pullBubbleBody(lists({ authored: [pull(9)], reviewing: many }), "#", REPO_URL, {
				maxRows: 4,
			}),
		);

		expect(body).toEqual([
			"Yours · 1",
			"#9 Pr 9 · open",
			"Waiting on your review · 1 of 3",
			"#1 Pr 1 · open",
			REPO_ROW,
		]);
	});
	it("drops a group the fit emptied instead of leaving a 0 of 8 heading", () => {
		const many = Array.from({ length: 3 }, (_, index) => pull(index + 1));
		const body = texts(
			pullBubbleBody(lists({ authored: many, reviewing: many }), "#", REPO_URL, { maxRows: 3 }),
		);

		expect(body).toEqual(["Yours · 1 of 3", "#1 Pr 1 · open", REPO_ROW]);
	});

	it("says how many of the forge's total it is showing", () => {
		const rows = Array.from({ length: 8 }, (_, index) => issue(index + 1));
		const body = texts(
			pullBubbleBody(lists(), "#", REPO_URL, {
				issues: issueLists({ openCount: 40, assigned: { items: rows, total: 40 } }),
				issuesUrl: `${REPO_URL}/issues`,
			}),
		);

		// The search returns at most eight; a heading that said `· 40` under eight
		// rows would read as a complete list.
		expect(body[0]).toBe("Assigned to you · 8 of 40");
	});
});
