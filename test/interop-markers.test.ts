import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { PolishedTuiConfig } from "../extensions/starline/config";
import { defaultConfig } from "../extensions/starline/config";
import {
	getStarlineEditorBaseFactory,
	isStarlineEditorFactory,
	markEditorFactory,
} from "../extensions/starline/editor-factory-marker";
import {
	installPrototypePatch,
	STARLINE_PROTOTYPE_PATCH_REGISTRY,
} from "../extensions/starline/prototype-patch-registry";
import { PolishedEditor, WrappedPolishedEditor } from "../extensions/starline/ui";

const EDITOR_FACTORY = Symbol.for("pi-starline.editor-factory");
const EDITOR_BASE_FACTORY = Symbol.for("pi-starline.editor-base-factory");
const SPLIT_POLISHED_FRAME = Symbol.for("pi-starline.polished-frame");

describe("editor factory marking", () => {
	it("marks a factory, so a second install recognises its own work", () => {
		const factory = markEditorFactory(() => undefined);

		expect(isStarlineEditorFactory(factory)).toBe(true);
		expect((factory as unknown as Record<PropertyKey, unknown>)[EDITOR_FACTORY]).toBe(true);
	});

	it("stores the base factory it wrapped", () => {
		const base = () => undefined;
		const factory = markEditorFactory(() => undefined, base);

		expect((factory as unknown as Record<PropertyKey, unknown>)[EDITOR_BASE_FACTORY]).toBe(base);
		expect(getStarlineEditorBaseFactory(factory)).toBe(base);
	});

	it("returns false for undefined and for an unmarked factory", () => {
		expect(isStarlineEditorFactory(undefined)).toBe(false);
		expect(isStarlineEditorFactory(() => undefined)).toBe(false);
	});
});

describe("prototype patch registry", () => {
	it("stores one registry under the starline key", () => {
		const target = { render: () => "original" };

		const cleanup = installPrototypePatch(
			target,
			"render",
			"selector-border-render",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		expect(
			(target as unknown as Record<PropertyKey, unknown>)[STARLINE_PROTOTYPE_PATCH_REGISTRY],
		).toBeInstanceOf(Map);
		cleanup();
	});

	it("adopts a registry the same package already installed", () => {
		const target = { render: () => "original" } as unknown as Record<PropertyKey, unknown>;
		const existing = new Map();
		Object.defineProperty(target, STARLINE_PROTOTYPE_PATCH_REGISTRY, {
			value: existing,
			configurable: true,
		});

		const cleanup = installPrototypePatch(
			target as unknown as object,
			"render",
			"selector-border-render",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		// Adopted, not shadowed: one registry, so nothing double-patches.
		expect(existing.size).toBe(1);
		cleanup();
	});
});

function makeTheme(): Theme {
	return {
		fg: (color: string, text: string) => `[${color}]${text}`,
		bold: (text: string) => `[bold]${text}`,
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
	);
}

describe("polished-frame split marker", () => {
	const config = defaultConfig;

	it("exposes the splitter on a starline-built editor", () => {
		const inner = makeEditor(config) as unknown as Record<PropertyKey, unknown>;

		expect(typeof inner[SPLIT_POLISHED_FRAME]).toBe("function");
	});

	it("unwraps a starline-built base instead of rendering its frame twice", () => {
		const inner = makeEditor(config);
		inner.setText("typed text");

		const wrapped = new WrappedPolishedEditor(inner as never, makeTheme(), () => config);

		expect(
			wrapped
				.render(120)
				.join("\n")
				.match(/typed text/g),
		).toHaveLength(1);
	});
});
