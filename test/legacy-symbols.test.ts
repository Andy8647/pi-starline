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

const LEGACY_REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");
const LEGACY_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");
const LEGACY_EDITOR_BASE_FACTORY = Symbol.for("pi-zentui.editor-base-factory");
const NEW_SPLIT_POLISHED_FRAME = Symbol.for("pi-starline.polished-frame");
const LEGACY_SPLIT_POLISHED_FRAME = Symbol.for("pi-zentui.polished-frame");

describe("editor factory marking", () => {
	it("marks a factory under the starline key", () => {
		const factory = markEditorFactory(() => undefined);

		expect(isStarlineEditorFactory(factory)).toBe(true);
		expect(
			(factory as unknown as Record<PropertyKey, unknown>)[
				Symbol.for("pi-starline.editor-factory")
			],
		).toBe(true);
	});

	it("recognises a factory marked by the pre-rename package", () => {
		const legacy = (() => undefined) as unknown as Record<PropertyKey, unknown>;
		legacy[LEGACY_EDITOR_FACTORY] = true;

		expect(isStarlineEditorFactory(legacy)).toBe(true);
	});

	it("reads a base factory stored under either key", () => {
		const base = () => undefined;

		const current = markEditorFactory(() => undefined, base);
		expect(getStarlineEditorBaseFactory(current)).toBe(base);

		const legacy = (() => undefined) as unknown as Record<PropertyKey, unknown>;
		legacy[LEGACY_EDITOR_BASE_FACTORY] = base;
		expect(getStarlineEditorBaseFactory(legacy)).toBe(base);
	});

	it("returns false for undefined and for an unmarked factory", () => {
		expect(isStarlineEditorFactory(undefined)).toBe(false);
		expect(isStarlineEditorFactory(() => undefined)).toBe(false);
	});

	it("also marks a factory under the legacy key, for a pi-zentui reader loading second", () => {
		const base = () => undefined;
		const factory = markEditorFactory(() => undefined, base);
		const legacyShaped = factory as unknown as Record<PropertyKey, unknown>;

		// A reader that only knows the pre-rename keys (i.e. pi-zentui, loaded
		// after pi-starline) must still recognise this factory as its own.
		expect(legacyShaped[LEGACY_EDITOR_FACTORY]).toBe(true);
		expect(legacyShaped[LEGACY_EDITOR_BASE_FACTORY]).toBe(base);
	});
});

describe("prototype patch registry", () => {
	it("stores its registry under the starline key", () => {
		const target = { render: () => "original" };

		const cleanup = installPrototypePatch(
			target,
			"render",
			"user-message-render",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		expect(
			(target as unknown as Record<PropertyKey, unknown>)[STARLINE_PROTOTYPE_PATCH_REGISTRY],
		).toBeInstanceOf(Map);
		cleanup();
	});

	it("adopts a registry the pre-rename package already installed", () => {
		const target = { render: () => "original" } as unknown as Record<PropertyKey, unknown>;
		const existing = new Map();
		Object.defineProperty(target, LEGACY_REGISTRY, { value: existing, configurable: true });

		const cleanup = installPrototypePatch(
			target as unknown as object,
			"render",
			"user-message-render",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		// Adopted, not shadowed: one registry, so neither package double-patches.
		expect(existing.size).toBe(1);
		expect(target[STARLINE_PROTOTYPE_PATCH_REGISTRY]).toBeUndefined();
		cleanup();
	});

	it("also stores the registry under the legacy key, so a pi-zentui reader loading second finds and shares it", () => {
		const target = { render: () => "original" };

		const cleanup = installPrototypePatch(
			target,
			"render",
			"user-message-render",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		const starlineMap = (target as unknown as Record<PropertyKey, unknown>)[
			STARLINE_PROTOTYPE_PATCH_REGISTRY
		];
		const legacyMap = (target as unknown as Record<PropertyKey, unknown>)[LEGACY_REGISTRY];

		expect(legacyMap).toBeInstanceOf(Map);
		// Same Map under both keys, not two independently maintained registries.
		expect(legacyMap).toBe(starlineMap);
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
		() => ({ modelLabel: "m", providerLabel: "p" }),
		() => "off",
	);
}

describe("polished-frame split marker", () => {
	const config = { ...defaultConfig, editorMetadataFormat: "the-meta" };

	it("exposes the splitter under both the starline and legacy keys on a starline-built editor", () => {
		const inner = makeEditor(config) as unknown as Record<PropertyKey, unknown>;

		expect(typeof inner[NEW_SPLIT_POLISHED_FRAME]).toBe("function");
		expect(typeof inner[LEGACY_SPLIT_POLISHED_FRAME]).toBe("function");
		// Same underlying implementation, not two separately maintained copies.
		expect(inner[LEGACY_SPLIT_POLISHED_FRAME]).toBe(inner[NEW_SPLIT_POLISHED_FRAME]);
	});

	it("still unwraps a base that only exposes the splitter under the legacy key", () => {
		const inner = makeEditor(config);
		inner.setText("typed text");

		// Simulate a base built by the pre-rename package: it never learned the
		// new key, so shadow it away and rely on the legacy key alone.
		const legacyOnlyBase = inner as unknown as Record<PropertyKey, unknown>;
		Object.defineProperty(legacyOnlyBase, NEW_SPLIT_POLISHED_FRAME, {
			value: undefined,
			configurable: true,
		});

		const wrapped = new WrappedPolishedEditor(
			inner as never,
			makeTheme(),
			() => config,
			() => ({ modelLabel: "m2", providerLabel: "p2" }),
			() => "off",
		);

		// If the legacy-key fallback were removed, splitBaseFrame would be
		// undefined and the inner frame would render twice instead of once.
		expect(
			wrapped
				.render(120)
				.join("\n")
				.match(/typed text/g),
		).toHaveLength(1);
	});
});
