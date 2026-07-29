import { describe, expect, it } from "vitest";
import {
	getStarlineEditorBaseFactory,
	isStarlineEditorFactory,
	markEditorFactory,
} from "../extensions/starline/editor-factory-marker";
import {
	installPrototypePatch,
	STARLINE_PROTOTYPE_PATCH_REGISTRY,
} from "../extensions/starline/prototype-patch-registry";

const LEGACY_REGISTRY = Symbol.for("pi-zentui.prototype-patch-registry");
const LEGACY_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");
const LEGACY_EDITOR_BASE_FACTORY = Symbol.for("pi-zentui.editor-base-factory");

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
});
