import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig, type PolishedTuiConfig } from "../extensions/starline/config";
import { PolishedEditor } from "../extensions/starline/ui";
import {
	footerRendersModel,
	modelPillIcon,
	readWorkingFrame,
	setWorkingIndicator,
	workingStatusForBorder,
} from "../extensions/starline/working-indicator";

/** A stand-in for Pi's StatusIndicator: one spinner cell plus a message. */
function indicator(kind: string, message = "Working", frames: string[] = ["⣾"]) {
	return {
		kind,
		renderSpinnerInBorder: (width: number) => (frames[0] ?? "").slice(0, width),
		renderInBorder: (width: number) => `${frames[0] ?? ""} ${message}`.slice(0, width),
	};
}

describe("readWorkingFrame", () => {
	it("is undefined with no indicator, so the pill keeps its icon", () => {
		setWorkingIndicator(undefined);
		expect(readWorkingFrame()).toBeUndefined();
	});

	it("returns the plain spinner frame while working", () => {
		setWorkingIndicator(indicator("working"));
		expect(readWorkingFrame()).toBe("⣾");
	});

	it("stays out of the pill for statuses that spell a sentence", () => {
		for (const kind of ["retry", "compaction", "branchSummary"]) {
			setWorkingIndicator(indicator(kind, "Compacting context..."));
			expect(readWorkingFrame()).toBeUndefined();
		}
	});

	// Pi allows `setWorkingIndicator({ frames: [] })`, which hides the animation.
	it("gives the icon back when the animation is hidden", () => {
		setWorkingIndicator(indicator("working", "Working", []));
		expect(readWorkingFrame()).toBeUndefined();
	});

	it("survives a Pi build whose indicator has no render helpers", () => {
		setWorkingIndicator({ kind: "working" });
		expect(readWorkingFrame()).toBeUndefined();
		expect(workingStatusForBorder(defaultConfig, 80)).toBeUndefined();
	});

	it("strips the colour Pi painted the frame with", () => {
		setWorkingIndicator({
			kind: "working",
			renderSpinnerInBorder: () => "\u001b[38;5;1m⣾\u001b[0m",
		});
		expect(readWorkingFrame()).toBe("⣾");
	});
});

/**
 * Pi's sparse braille hugs the top-left of the cell, which in a short pill reads
 * as a speck floating above the model name. The pill swaps in the filled grid and
 * keeps Pi's cadence by reusing the frame index.
 */
describe("the pill's own frames", () => {
	it("replaces Pi's sparse frames with the filled ones", () => {
		setWorkingIndicator(indicator("working", "Working", ["⠋"]));
		expect(readWorkingFrame()).toBe("⣾");

		setWorkingIndicator(indicator("working", "Working", ["⠏"]));
		expect(readWorkingFrame()).toBe("⣷");
	});

	it("leaves customized frames alone", () => {
		setWorkingIndicator(indicator("working", "Working", ["◐"]));
		expect(readWorkingFrame()).toBe("◐");
	});
});

describe("modelPillIcon", () => {
	it("leaves the configured icon alone when nothing is working", () => {
		expect(modelPillIcon("\uf0c2", undefined)).toBe("\uf0c2");
	});

	it("swaps a one-cell icon for the frame in place, so the pill keeps its width", () => {
		const swapped = modelPillIcon("\uf0c2", "⣾");
		expect(swapped).toBe("⣾");
		expect([...swapped]).toHaveLength([..."\uf0c2"].length);
	});

	it("pads a frame under a wider icon", () => {
		expect(modelPillIcon("🤖", "⣾")).toBe("⣾ ");
	});

	it("gives an icon-less pill the cells the spinner needs", () => {
		expect(modelPillIcon("", "⣾")).toBe("⣾");
	});
});

describe("footerRendersModel", () => {
	const pill = (segments: string[]) => mergeConfig({ pill: { segments } });

	it("is true when the bar lists the model", () => {
		expect(footerRendersModel(pill(["model", "cwd"]))).toBe(true);
	});

	it("is false when the bar does not list the model", () => {
		expect(footerRendersModel(pill(["cwd", "gitBranch"]))).toBe(false);
	});

	it("is false whenever the status line itself is off", () => {
		const off = mergeConfig({ features: { statusLine: false } });
		expect(footerRendersModel(off)).toBe(false);
	});
});

describe("workingStatusForBorder", () => {
	const pill = (segments: string[]) => mergeConfig({ pill: { segments } });

	it("stays out of the border when the pill can carry the spinner", () => {
		setWorkingIndicator(indicator("working"));
		expect(workingStatusForBorder(pill(["model", "cwd"]), 80)).toBeUndefined();
	});

	it("falls back to the border when there is no model pill", () => {
		setWorkingIndicator(indicator("working"));
		expect(workingStatusForBorder(pill(["cwd"]), 80)).toBe("⣾ Working");
	});

	it("always puts the long statuses on the border, truncating to the width", () => {
		setWorkingIndicator(indicator("compaction", "Compacting context... (esc to cancel)"));
		expect(workingStatusForBorder(pill(["model"]), 80)).toBe(
			"⣾ Compacting context... (esc to cancel)",
		);
		expect(workingStatusForBorder(pill(["model"]), 12)).toBe("⣾ Compacting".slice(0, 12));
	});

	it("clears once Pi hands over undefined", () => {
		setWorkingIndicator(indicator("working"));
		setWorkingIndicator(undefined);
		expect(workingStatusForBorder(pill(["cwd"]), 80)).toBeUndefined();
	});
});

/**
 * The part Pi actually reads: `isWorkingStatusEditor` duck-types the mounted
 * editor for these two members. Miss either one and Pi quietly falls back to its
 * own row above the editor, which is exactly the behaviour this feature exists
 * to replace.
 */
describe("the editor advertises Pi's embedding contract", () => {
	function makeTheme(): Theme {
		return {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			italic: (text: string) => text,
			underline: (text: string) => text,
			strikethrough: (text: string) => text,
			getThinkingBorderColor: () => (text: string) => text,
		} as unknown as Theme;
	}

	function makeEditor(config: PolishedTuiConfig) {
		return new PolishedEditor(
			{ requestRender() {}, terminal: { rows: 24, cols: 120 } } as never,
			{ borderColor: (text: string) => text, selectList: {} } as never,
			{} as never,
			makeTheme(),
			() => config,
			() => ({ modelLabel: "m", providerLabel: "p" }),
			() => "off",
		);
	}

	const bare = { ...defaultConfig, editorMetadataFormat: "", editorPaddingY: 0 };
	const stripTags = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
	const isRule = (line: string) => /^─+$/.test(stripTags(line).trim());

	it("flags the editor and takes the indicator", () => {
		const editor = makeEditor(bare);
		expect((editor as unknown as { embedWorkingStatus?: boolean }).embedWorkingStatus).toBe(true);
		expect(
			typeof (editor as unknown as { setWorkingStatusIndicator?: unknown })
				.setWorkingStatusIndicator,
		).toBe("function");
	});

	it("puts a long status on the top rule when the footer cannot carry the spinner", () => {
		setWorkingIndicator(undefined);
		const editor = makeEditor(bare);
		editor.setWorkingStatusIndicator(indicator("retry", "Retrying (1/3) in 4s..."));
		const top = stripTags(editor.render(120)[0] ?? "").trimEnd();

		expect(top.startsWith("── ⣾ Retrying (1/3) in 4s...")).toBe(true);
		expect(top.endsWith("─")).toBe(true);
	});

	it("leaves the top rule bare when the model pill carries the spinner", () => {
		setWorkingIndicator(undefined);
		const editor = makeEditor(
			mergeConfig({ footerStyle: "pill", pill: { segments: ["model", "cwd"] } }),
		);
		editor.setWorkingStatusIndicator(indicator("working"));

		expect(isRule(editor.render(120)[0] ?? "")).toBe(true);
		expect(readWorkingFrame()).toBe("⣾");
	});

	it("gives the top rule back once the status clears", () => {
		setWorkingIndicator(undefined);
		const editor = makeEditor(bare);
		editor.setWorkingStatusIndicator(indicator("working"));
		editor.setWorkingStatusIndicator(undefined);

		expect(isRule(editor.render(120)[0] ?? "")).toBe(true);
		expect(readWorkingFrame()).toBeUndefined();
	});
});
