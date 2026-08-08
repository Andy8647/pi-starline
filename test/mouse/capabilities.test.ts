import { describe, expect, it } from "vitest";
import {
	disabledFeatureWarning,
	enabledFeatures,
	probeCapabilities,
} from "../../extensions/starline/mouse/capabilities";

function prototypeWith(names: string[]): object {
	const proto: Record<string, unknown> = {};
	for (const name of names) proto[name] = function stub() {};
	return proto;
}

const ALL = [
	"handleViewportInput",
	"routeWheel",
	"handleSelectionMouseEvent",
	"copySelectionToClipboard",
	"getWordSelection",
	"getSelectionSourceLine",
	"getSelectionBounds",
	"getSelectionColumns",
	"flash",
];

describe("probeCapabilities", () => {
	it("finds every capability on a complete prototype", () => {
		expect([...probeCapabilities(prototypeWith(ALL))].sort()).toEqual([...ALL].sort());
	});

	it("skips a non-function property", () => {
		const proto = prototypeWith(ALL) as Record<string, unknown>;
		proto.routeWheel = 42;
		expect(probeCapabilities(proto).has("routeWheel")).toBe(false);
	});

	it("skips a non-writable method", () => {
		const proto = prototypeWith(ALL);
		Object.defineProperty(proto, "copySelectionToClipboard", {
			value: () => undefined,
			writable: false,
			configurable: true,
		});
		expect(probeCapabilities(proto).has("copySelectionToClipboard")).toBe(false);
	});

	it("skips a non-configurable method", () => {
		const proto = prototypeWith(ALL);
		Object.defineProperty(proto, "getWordSelection", {
			value: () => undefined,
			writable: true,
			configurable: false,
		});
		expect(probeCapabilities(proto).has("getWordSelection")).toBe(false);
	});

	it("skips an accessor property", () => {
		const proto = prototypeWith(ALL);
		Object.defineProperty(proto, "routeWheel", {
			get() {
				throw new Error("boom");
			},
			configurable: true,
		});
		expect(probeCapabilities(proto).has("routeWheel")).toBe(false);
	});

	it("disables a capability when the prototype throws on inspection", () => {
		// Pi 0.84 hands extensions a Proxy over its renderer, so a probe can be
		// pointed at one whose traps throw. The rule is that a probe never
		// propagates: it reports the capability as unavailable and the feature
		// depending on it stays off.
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error("boom");
				},
				getPrototypeOf() {
					return null;
				},
			},
		);
		expect(() => probeCapabilities(hostile)).not.toThrow();
		expect(probeCapabilities(hostile).size).toBe(0);
	});
});

describe("enabledFeatures", () => {
	it("enables everything when every capability is present", () => {
		const features = enabledFeatures(probeCapabilities(prototypeWith(ALL)));
		expect(features.size).toBe(6);
	});

	it("disables the pending mode when ctrl+c cannot be intercepted", () => {
		const without = ALL.filter((name) => name !== "handleViewportInput");
		const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
		expect(features.has("selectionPendingMode")).toBe(false);
		// Copying from the editor buffer needs no key interception.
		expect(features.has("editorBufferCopy")).toBe(true);
	});

	it("claims no feature that installMouse would not install", () => {
		// A capability probe is a report on Pi's surface; a *feature* is a
		// promise that installMouse installs something. Frame-free selection is
		// cut, so neither it nor the `applySelection` it was highlighted
		// through survives anywhere in here.
		const features = enabledFeatures(probeCapabilities(prototypeWith(ALL)));
		expect([...features].sort()).toEqual([
			"clickToExpandTools",
			"editorBufferCopy",
			"editorClickToCaret",
			"editorWheelScroll",
			"pathAwareWords",
			"selectionPendingMode",
		]);
	});

	it("disables both click features when the mouse event handler is missing", () => {
		const without = ALL.filter((name) => name !== "handleSelectionMouseEvent");
		const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
		expect(features.has("clickToExpandTools")).toBe(false);
		expect(features.has("editorClickToCaret")).toBe(false);
	});
});

describe("disabledFeatureWarning", () => {
	it("is silent when nothing is disabled", () => {
		expect(
			disabledFeatureWarning(enabledFeatures(probeCapabilities(prototypeWith(ALL)))),
		).toBeNull();
	});

	it("names every disabled feature in one message", () => {
		const features = enabledFeatures(probeCapabilities(prototypeWith([])));
		const warning = disabledFeatureWarning(features);
		expect(warning).toContain("selectionPendingMode");
		expect(warning).toContain("editorWheelScroll");
		expect(warning?.split("\n")).toHaveLength(1);
	});
});
