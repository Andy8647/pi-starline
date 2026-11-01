import { describe, expect, it } from "vitest";
import type { Pull, PullLists } from "../extensions/starline/pull";
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
