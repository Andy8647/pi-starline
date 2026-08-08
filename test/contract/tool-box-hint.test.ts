/**
 * Click-to-expand, against the real `pi-coding-agent` components it targets.
 *
 * `test/mouse/tool-box.test.ts` exercises the rule against a fixture modelled
 * on `BashExecutionComponent`. This runs it against the component itself, and
 * pins the two things only the installed package can answer:
 *
 * - The hint really is `(… <keys> to expand)` / `(… <keys> to collapse)`,
 *   rendered by `keyHint("app.tools.expand", …)`, with the parentheses the
 *   match depends on. If Pi rewords it, this goes red at build time rather
 *   than the feature going quietly inert on a user's machine.
 * - A real expandable component really does resolve through the component
 *   tree from a screen cell, in a real `renderLayoutFrame` — including after
 *   the box has been expanded and its rows have moved.
 *
 * ## The two keybinding registries
 *
 * `getKeybindings()` is a singleton per *copy* of pi-tui, and this repo has
 * two: the top-level one Starline imports, and the one `pi-coding-agent` nests
 * under itself. `keyText` reads the nested one, so the hint renders with an
 * empty key unless that copy is the one told about `app.tools.expand`. It is
 * resolved here the way Node resolves it for `pi-coding-agent` itself, so this
 * keeps working whether npm nests the copy or hoists it. Production has one
 * copy and the question does not arise — which is exactly why `expandKeyText`
 * reads the value through the package that renders it.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	BashExecutionComponent,
	initTheme,
	keyHint,
	keyText,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	stripTerminalSequences,
	Text,
	VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isExpandableComponent } from "../../extensions/starline/mouse/component-tree";
import type { BoxLike } from "../../extensions/starline/mouse/hit-test";
import {
	expandHintAction,
	expandKeyText,
	expandTargetAt,
} from "../../extensions/starline/mouse/tool-box";

const WIDTH = 60;
const KEY = "ctrl+o";

type KeybindingsModule = {
	getKeybindings(): unknown;
	setKeybindings(manager: unknown): void;
	KeybindingsManager: new (definitions: unknown, userBindings?: unknown) => unknown;
};

/** pi-tui as `pi-coding-agent` resolves it, nested or hoisted. */
async function piTuiForCodingAgent(): Promise<KeybindingsModule> {
	// `import.meta.resolve` for the entry (pi-coding-agent publishes ESM-only
	// exports, which `require.resolve` cannot see), then a CJS-style resolve
	// from that directory for its view of pi-tui.
	const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const require = createRequire(import.meta.url);
	const piTui = require.resolve("@earendil-works/pi-tui", { paths: [dirname(agentEntry)] });
	return (await import(pathToFileURL(piTui).href)) as KeybindingsModule;
}

let restoreKeybindings: (() => void) | undefined;

beforeAll(async () => {
	const piTui = await piTuiForCodingAgent();
	const previous = piTui.getKeybindings();
	restoreKeybindings = () => piTui.setKeybindings(previous);
	piTui.setKeybindings(new piTui.KeybindingsManager({ "app.tools.expand": { defaultKeys: KEY } }));
	initTheme("dark");
});

afterAll(() => restoreKeybindings?.());

/** A finished bash box with more output than its preview shows. */
function makeBashBox() {
	const ui = { requestRender() {}, addChild() {}, removeChild() {} } as never;
	const box = new BashExecutionComponent("echo hi", ui, false) as unknown as {
		appendOutput(chunk: string): void;
		setComplete(exitCode: number, cancelled: boolean): void;
		setExpanded(expanded: boolean): void;
		render(width: number): string[];
	};
	box.appendOutput(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"));
	box.setComplete(0, false);
	return box;
}

/** The transcript shape `interactive-mode.js` builds, laid out for real. */
function layout(box: unknown, height: number) {
	const document = new Container();
	const chat = new Container();
	document.addChild(chat);
	chat.addChild(new Text("first message", 0, 0));
	chat.addChild(box as never);
	const scroll = new ScrollView(document);
	const frame = renderLayoutFrame(
		new VStack([{ component: scroll, grow: 1 }, { component: new Text("dock", 0, 0) }]),
		WIDTH,
		height,
		() => {},
	);
	const scrollBox = frame.root.children[0] as BoxLike & {
		scrollView?: unknown;
		scrollContentLines?: readonly string[];
	};
	const contentBox = (scrollBox.children ?? [])[0];
	if (!contentBox) throw new Error("the scroll view laid out no content box");
	const lines = scrollBox.scrollContentLines ?? [];
	return {
		root: frame.root as BoxLike,
		lines,
		/** Screen y of the row whose plain text contains `needle`. */
		screenY(needle: string): number {
			const row = lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
			if (row < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
			return contentBox.rect.y + row;
		},
	};
}

describe("Pi's expand hint", () => {
	it("still comes from keyText and keyHint on the package root", () => {
		expect(typeof keyText).toBe("function");
		expect(typeof keyHint).toBe("function");
		expect(keyText("app.tools.expand" as never)).toBe(KEY);
		// The value `expandHintAction` is handed comes from Pi's own function.
		expect(expandKeyText()).toBe(KEY);
	});

	it("renders both directions in the shape the rule matches", () => {
		// `bash-execution.js:140,143` builds exactly these two.
		const collapsed = `... 20 more lines (${keyHint("app.tools.expand" as never, "to expand")})`;
		const expanded = `(${keyHint("app.tools.expand" as never, "to collapse")})`;

		expect(expandHintAction(collapsed, expandKeyText())).toBe("expand");
		expect(expandHintAction(expanded, expandKeyText())).toBe("collapse");
	});

	it("puts a hint on a real collapsed bash box, and none on its output rows", () => {
		const box = makeBashBox();
		const rows = box.render(WIDTH).map((line) => stripTerminalSequences(line));
		const hints = rows.filter((row) => expandHintAction(row, expandKeyText()));

		expect(hints).toHaveLength(1);
		expect(hints[0]).toContain(`${KEY} to expand)`);
	});
});

describe("a real tool box under the pointer", () => {
	it("is expandable by the duck type the walk uses", () => {
		expect(isExpandableComponent(makeBashBox())).toBe(true);
		expect(typeof ToolExecutionComponent.prototype.setExpanded).toBe("function");
	});

	it("resolves from its hint row and asks to expand", () => {
		const box = makeBashBox();
		const scene = layout(box, 60);

		const target = expandTargetAt(
			{ root: scene.root, keyText: expandKeyText() },
			4,
			scene.screenY(`${KEY} to expand)`),
		);

		expect(target?.component).toBe(box);
		expect(target?.expanded).toBe(true);
	});

	it("leaves the command line and the output rows to selection", () => {
		const box = makeBashBox();
		const scene = layout(box, 60);
		const lookup = { root: scene.root, keyText: expandKeyText() };

		expect(expandTargetAt(lookup, 4, scene.screenY("$ echo hi"))).toBeUndefined();
		expect(expandTargetAt(lookup, 4, scene.screenY("line 25"))).toBeUndefined();
	});

	it("asks to collapse once the box has been expanded and its rows have moved", () => {
		const box = makeBashBox();
		layout(box, 60);
		box.setExpanded(true);
		const scene = layout(box, 120);

		const target = expandTargetAt(
			{ root: scene.root, keyText: expandKeyText() },
			4,
			scene.screenY(`${KEY} to collapse)`),
		);

		expect(target?.component).toBe(box);
		expect(target?.expanded).toBe(false);
	});
});
