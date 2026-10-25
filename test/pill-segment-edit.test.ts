import { describe, expect, it } from "vitest";
import { defaultConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import {
	movePillSegment,
	PILL_SEGMENT_NAMES,
	pillSegmentPosition,
} from "../extensions/starline/pill-config";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";

const segments = defaultConfig.pill.segments;

describe("movePillSegment", () => {
	it("removes a segment when the value is off", () => {
		expect(movePillSegment(segments, "queue", "off")).toEqual(
			segments.filter((segment) => segment !== "queue"),
		);
	});

	it("inserts a hidden segment at the position picked", () => {
		const next = movePillSegment(segments, "runtime", "1");
		expect(next[0]).toBe("runtime");
		expect(next).toHaveLength(segments.length + 1);
	});

	it("appends a hidden segment when the position is past the end", () => {
		const next = movePillSegment(segments, "runtime", String(segments.length + 1));
		expect(next.at(-1)).toBe("runtime");
	});

	it("reorders a segment that is already in the bar", () => {
		const next = movePillSegment(segments, "model", "2");
		expect(next.slice(0, 3)).toEqual(["thinking", "model", "queue"]);
		expect(next).toHaveLength(segments.length);
	});

	it("ignores a value that is not a position", () => {
		expect(movePillSegment(segments, "queue", "soon")).toEqual(segments);
		expect(movePillSegment(segments, "queue", "0")).toEqual(segments);
	});
});

describe("pillSegmentPosition", () => {
	it("is 1-based, and 0 when the segment is not drawn", () => {
		expect(pillSegmentPosition(segments, "model")).toBe(1);
		expect(pillSegmentPosition(segments, "cost")).toBe(segments.indexOf("cost") + 1);
		expect(pillSegmentPosition(segments, "runtime")).toBe(0);
	});
});

describe("PILL_SEGMENT_NAMES", () => {
	it("lists every built-in plus the catch-all, and everything the default bar uses", () => {
		expect(PILL_SEGMENT_NAMES).toContain("extensionStatus");
		expect(PILL_SEGMENT_NAMES).toContain("gitMetrics");
		for (const segment of segments) expect(PILL_SEGMENT_NAMES).toContain(segment);
	});
});

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	getThinkingBorderColor: () => (text: string) => text,
};

/** The settings command reads config from deps; this keeps one object to edit. */
function settingsHarness(initial: PolishedTuiConfig = defaultConfig) {
	let config = initial;
	let picked: string[] | undefined;
	const notifications: string[] = [];
	let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

	registerStarlineSettingsCommand(
		{
			registerCommand(_name: string, options: unknown) {
				command = options as typeof command;
			},
		} as never,
		{
			sessionLifecycle: { currentGeneration: () => 1, isCurrent: () => true } as never,
			getConfig: () => config,
			setColorSources() {},
			setUiFeatures: () => ({ applied: true }),
			setIconMode() {},
			setContextStyle() {},
			setPathDisplay() {},
			setGitBranch() {},
			setPillSegments(next) {
				picked = [...next];
				config = { ...config, pill: { ...config.pill, segments: [...next] } };
			},
			getActiveExtensionStatuses: () => new Map<string, string>(),
			setExtensionStatusPlacement() {},
			setExtensionStatusColorMode() {},
			setMouseConfig() {},
			requestRender() {},
			settingsListTheme: {
				label: (text) => text,
				value: (text) => text,
				description: (text) => text,
				cursor: "> ",
				hint: (text) => text,
			},
		},
	);

	/** Open the menu, switch to a section, and hand the component back. */
	const open = async (tabs: number) => {
		let component:
			| { render: (width: number) => string[]; handleInput: (data: string) => void }
			| undefined;
		await command?.handler("", {
			hasUI: true,
			mode: "tui",
			ui: {
				theme,
				notify(message: string) {
					notifications.push(message);
				},
				async custom(factory: (...args: unknown[]) => unknown) {
					component = factory({ requestRender() {} }, theme, {}, () => {}) as typeof component;
					for (let index = 0; index < tabs; index += 1) component?.handleInput("\t");
				},
			},
		});
		return component as NonNullable<typeof component>;
	};

	return { open, picked: () => picked, notifications };
}

describe("/starline Pills tab", () => {
	it("lists one row per segment, with its position as the value", async () => {
		const harness = settingsHarness();
		const component = await harness.open(3);
		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("Pills");
		// The first eight rows are on screen; the rest scroll.
		expect(rendered).toMatch(/Model\s+1/);
		expect(rendered).toMatch(/Thinking\s+2/);
		expect(rendered).toMatch(/Git branch\s+6/);
		expect(rendered).toContain("1/23");
	});

	it("moves the selected segment when its value is cycled", async () => {
		const harness = settingsHarness();
		const component = await harness.open(3);

		// The cursor starts on Model, whose value is 1; one space moves it to 2.
		component.handleInput(" ");

		const expected = movePillSegment(segments, "model", "2");
		expect(harness.picked()).toEqual(expected);
		expect(harness.notifications).toContain("Model: position 2");

		const rerendered = component.render(120).join("\n");
		expect(rerendered).toMatch(/Thinking\s+1/);
		expect(rerendered).toMatch(/Model\s+2/);
	});
});
