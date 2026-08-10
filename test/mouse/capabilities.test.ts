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
	"hasOverlay",
	"requestRender",
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
		expect(features.size).toBe(7);
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
			"transcriptCleanCopy",
		]);
	});

	it("disables both repainting features when the renderer cannot be asked to repaint", () => {
		// `requestRender` is the one capability these features only ever *call*.
		// Installing without it leaves the pending hint and a toggled tool box off
		// screen until some unrelated frame arrives, which is the half-working
		// install this table exists to prevent.
		const without = ALL.filter((name) => name !== "requestRender");
		const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
		expect(features.has("selectionPendingMode")).toBe(false);
		expect(features.has("clickToExpandTools")).toBe(false);
		// The wheel patch consumes the notch, so Pi never reaches the repaint at
		// the end of its own `routeWheel`: without one of its own, the box would
		// scroll and not be redrawn.
		expect(features.has("editorWheelScroll")).toBe(false);
		// Word selection returns a range and lets Pi repaint on its own path.
		expect(features.has("pathAwareWords")).toBe(true);
		// Click-to-caret needs it too, but only because of its *second* half: the
		// caret alone calls through and rides Pi's own repaint, while the range
		// delete consumes the key, so Pi never reaches `requestImmediateRender`
		// and the shortened draft would stay on screen unchanged.
		expect(features.has("editorClickToCaret")).toBe(false);
	});

	it("disables click-to-expand when overlays cannot be detected", () => {
		// Without `hasOverlay` the feature would resolve a tool box through an
		// open dialog and toggle it on a click aimed at the dialog. It is a
		// capability the feature *calls*, so it gates installation like any other.
		const without = ALL.filter((name) => name !== "hasOverlay");
		const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
		expect(features.has("clickToExpandTools")).toBe(false);
		// An overlay is composited over a layout that still contains the editor,
		// so without this the wheel would scroll a draft hidden behind a dialog.
		expect(features.has("editorWheelScroll")).toBe(false);
		expect(features.has("selectionPendingMode")).toBe(true);
		// The same layout an overlay is composited over still holds the editor, so
		// both editor click features would answer for rows a dialog is covering.
		expect(features.has("editorClickToCaret")).toBe(false);
		expect(features.has("editorBufferCopy")).toBe(false);
	});

	it("disables both click features when the mouse event handler is missing", () => {
		const without = ALL.filter((name) => name !== "handleSelectionMouseEvent");
		const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
		expect(features.has("clickToExpandTools")).toBe(false);
		expect(features.has("editorClickToCaret")).toBe(false);
	});

	it("disables buffer copy without the selection it would have to recognise", () => {
		// It has to read the bounds to find out whether the selection is the
		// editor's at all, and it raises Pi's own "Copied!" itself because it
		// answers the copy instead of calling through.
		for (const capability of ["getSelectionBounds", "flash"] as const) {
			const without = ALL.filter((name) => name !== capability);
			const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
			expect(features.has("editorBufferCopy")).toBe(false);
		}
	});

	it("disables click-to-caret without the key path its range delete needs", () => {
		// Backspace and delete over a live selection arrive through
		// `handleViewportInput`, and the branch reads `getSelectionBounds` to find
		// out whether the selection is the editor's. Losing either would leave a
		// caret that installs while its delete silently did not.
		for (const capability of ["handleViewportInput", "getSelectionBounds"] as const) {
			const without = ALL.filter((name) => name !== capability);
			const features = enabledFeatures(probeCapabilities(prototypeWith(without)));
			expect(features.has("editorClickToCaret")).toBe(false);
		}
		// `flash` is the buffer copy's, not the caret's.
		const withoutFlash = ALL.filter((name) => name !== "flash");
		expect(
			enabledFeatures(probeCapabilities(prototypeWith(withoutFlash))).has("editorClickToCaret"),
		).toBe(true);
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
