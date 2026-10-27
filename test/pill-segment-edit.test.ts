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
		expect(PILL_SEGMENT_NAMES).toContain("git");
		for (const segment of segments) expect(PILL_SEGMENT_NAMES).toContain(segment);
		// The tokens and cache numbers ride in the context pill now.
		expect(PILL_SEGMENT_NAMES).not.toContain("tokens");
		expect(PILL_SEGMENT_NAMES).not.toContain("cacheHit");
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
function settingsHarness(
	initial: PolishedTuiConfig = defaultConfig,
	statuses: ReadonlyMap<string, string> = new Map(),
) {
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
			getActiveExtensionStatuses: () => statuses,
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
		expect(rendered).toMatch(/Git\s+6/);
		expect(rendered).toContain(`1/${PILL_SEGMENT_NAMES.length}`);
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

	it("gives every status published this session its own row, after the built-ins", async () => {
		const harness = settingsHarness(defaultConfig, new Map([["alpha", "41.1%"]]));
		const component = await harness.open(3);

		// One row per built-in segment, then one per status.
		expect(component.render(120).join("\n")).toContain(`1/${PILL_SEGMENT_NAMES.length + 1}`);

		// The last row is the status, labelled with its key and off the bar.
		for (let index = 0; index < PILL_SEGMENT_NAMES.length; index += 1) {
			component.handleInput("\x1b[B");
		}
		const rendered = component.render(120).join("\n");
		expect(rendered).toMatch(/alpha\s+off/);
	});

	it("can turn off a segment that already sits at the end of the bar", async () => {
		// A segment on the bar has no "one past the end" value: appending it would
		// put it back where it already is, and the cycle would never reach `off`.
		const config: PolishedTuiConfig = {
			...defaultConfig,
			pill: { ...defaultConfig.pill, segments: ["model", "time"] },
		};
		const harness = settingsHarness(config);
		const component = await harness.open(3);

		// Walk to the time row, whose segment is the last thing on the bar.
		for (let index = 0; index < PILL_SEGMENT_NAMES.indexOf("time"); index += 1) {
			component.handleInput("\x1b[B");
		}
		component.handleInput(" ");

		expect(harness.notifications.at(-1)).toBe("Time: off");
		expect(harness.picked()).toEqual(["model"]);
	});

	it("puts one status on the bar where it is placed, leaving the catch-all alone", async () => {
		const harness = settingsHarness(defaultConfig, new Map([["alpha", "41.1%"]]));
		const component = await harness.open(3);
		for (let index = 0; index < PILL_SEGMENT_NAMES.length; index += 1) {
			component.handleInput("\x1b[B");
		}

		// `off` cycles to position 1.
		component.handleInput(" ");

		const picked = harness.picked() as string[];
		expect(picked[0]).toBe("extensionStatus:alpha");
		// The catch-all still owns every other status.
		expect(picked).toContain("extensionStatus");
		expect(picked).toHaveLength(segments.length + 1);
		expect(harness.notifications).toContain("alpha: position 1");
	});

	it("shows where an already placed status sits, and cycles it off", async () => {
		const placed: PolishedTuiConfig = {
			...defaultConfig,
			pill: {
				...defaultConfig.pill,
				segments: ["extensionStatus:alpha", ...segments],
			},
		};
		const harness = settingsHarness(placed, new Map([["alpha", "41.1%"]]));
		const component = await harness.open(3);
		for (let index = 0; index < PILL_SEGMENT_NAMES.length; index += 1) {
			component.handleInput("\x1b[B");
		}

		expect(component.render(120).join("\n")).toMatch(/alpha\s+1\b/);

		// One space moves it from position 1 to position 2, like any other row.
		component.handleInput(" ");
		const picked = harness.picked() as string[];
		expect(picked[0]).toBe(segments[0]);
		expect(picked[1]).toBe("extensionStatus:alpha");
		expect(harness.notifications).toContain("alpha: position 2");
	});
});
