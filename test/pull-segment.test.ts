import { describe, expect, it } from "vitest";
import { ASCII_DEFAULT_ICONS, NERD_DEFAULT_ICONS } from "../extensions/starline/icons";
import type { Pull, PullSnapshot } from "../extensions/starline/pull";
import { pullColorSpec, pullMarker, pullSegmentText } from "../extensions/starline/pull";

const colors = {
	gitPrOpen: "open",
	gitPrDraft: "draft",
	gitPrMerged: "merged",
	gitPrClosed: "closed",
	gitPrCount: "count",
};

function pull(overrides: Partial<Pull> = {}): Pull {
	return { number: 123, state: "open", url: "https://example.test/123", ...overrides };
}

function snapshot(overrides: Partial<PullSnapshot> = {}): PullSnapshot {
	return { host: "github", ...overrides };
}

describe("pullSegmentText", () => {
	it("draws nothing without a snapshot", () => {
		expect(pullSegmentText(undefined, NERD_DEFAULT_ICONS)).toBe("");
	});

	it("marks a GitHub pull with # and a GitLab merge request with !", () => {
		expect(pullMarker("github")).toBe("#");
		expect(pullMarker("gitlab")).toBe("!");
		expect(pullMarker("generic")).toBe("#");

		expect(pullSegmentText(snapshot({ branch: pull() }), ASCII_DEFAULT_ICONS)).toBe("#123");
		expect(pullSegmentText(snapshot({ host: "gitlab", branch: pull() }), ASCII_DEFAULT_ICONS)).toBe(
			"!123",
		);
	});

	it("puts the state glyph in front and the checks mark behind", () => {
		const text = pullSegmentText(
			snapshot({ branch: pull({ checks: "failing" }) }),
			NERD_DEFAULT_ICONS,
		);

		expect(text).toBe(`${NERD_DEFAULT_ICONS.gitPrOpen} #123 ✗`);
	});

	it("picks the glyph from the pull's state", () => {
		const draft = pullSegmentText(
			snapshot({ branch: pull({ state: "draft" }) }),
			NERD_DEFAULT_ICONS,
		);
		const merged = pullSegmentText(
			snapshot({ branch: pull({ state: "merged" }) }),
			NERD_DEFAULT_ICONS,
		);
		const closed = pullSegmentText(
			snapshot({ branch: pull({ state: "closed" }) }),
			NERD_DEFAULT_ICONS,
		);

		expect(draft).toContain(NERD_DEFAULT_ICONS.gitPrDraft);
		expect(merged).toContain(NERD_DEFAULT_ICONS.gitPrMerged);
		expect(closed).toContain(NERD_DEFAULT_ICONS.gitPrClosed);
	});

	it("shows the repository's open count when the branch has no pull", () => {
		expect(pullSegmentText(snapshot({ openCount: 12 }), ASCII_DEFAULT_ICONS)).toBe("12");
		expect(pullSegmentText(snapshot({ openCount: 12 }), NERD_DEFAULT_ICONS)).toBe(
			`${NERD_DEFAULT_ICONS.gitPrList} 12`,
		);
	});

	it("draws nothing when neither a pull nor a count arrived", () => {
		expect(pullSegmentText(snapshot(), NERD_DEFAULT_ICONS)).toBe("");
		expect(pullSegmentText(snapshot({ openCount: undefined }), ASCII_DEFAULT_ICONS)).toBe("");
	});
});

describe("pullColorSpec", () => {
	it("colours a pull by its state", () => {
		expect(pullColorSpec(snapshot({ branch: pull() }), colors)).toBe("open");
		expect(pullColorSpec(snapshot({ branch: pull({ state: "draft" }) }), colors)).toBe("draft");
		expect(pullColorSpec(snapshot({ branch: pull({ state: "merged" }) }), colors)).toBe("merged");
		expect(pullColorSpec(snapshot({ branch: pull({ state: "closed" }) }), colors)).toBe("closed");
	});

	it("keeps a bare count neutral so it does not read as a pull", () => {
		expect(pullColorSpec(snapshot({ openCount: 4 }), colors)).toBe("count");
		expect(pullColorSpec(undefined, colors)).toBe("count");
	});
});
