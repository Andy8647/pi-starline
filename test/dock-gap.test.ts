import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAboveEditorGapHiding } from "../extensions/starline/dock-gap";

/**
 * The wrapper goes on Pi's real prototype over a stub predecessor, so the test
 * can tell "cleared instead of filled" from "forwarded" without initializing
 * Pi's theme. The original method is put back afterwards.
 */
type Container = { clear: () => void; addChild: (child: unknown) => void };

const prototype = InteractiveMode.prototype as unknown as {
	renderWidgetContainer: unknown;
};
const original = prototype.renderWidgetContainer;

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	prototype.renderWidgetContainer = original;
});

function install(enabled: () => boolean) {
	const predecessor = vi.fn();
	prototype.renderWidgetContainer = predecessor;
	dispose = installAboveEditorGapHiding(enabled);
	return predecessor;
}

function makeContainer(): Container {
	return { clear: vi.fn(), addChild: vi.fn() };
}

/** Call the wrapper the way `renderWidgets` does. */
function call(
	container: Container,
	widgets: Map<string, unknown>,
	spacerWhenEmpty: boolean,
	leadingSpacer = true,
): void {
	(
		prototype.renderWidgetContainer as (
			this: unknown,
			container: Container,
			widgets: Map<string, unknown>,
			spacerWhenEmpty: boolean,
			leadingSpacer: boolean,
		) => void
	).call({}, container, widgets, spacerWhenEmpty, leadingSpacer);
}

describe("hiding Pi's blank row above the editor", () => {
	it("clears the empty above-editor slot instead of filling it with a spacer", () => {
		const predecessor = install(() => true);
		const container = makeContainer();

		call(container, new Map(), true);

		expect(container.clear).toHaveBeenCalled();
		expect(container.addChild).not.toHaveBeenCalled();
		expect(predecessor).not.toHaveBeenCalled();
	});

	it("leaves a slot that really holds a widget to Pi", () => {
		const predecessor = install(() => true);
		const container = makeContainer();

		call(container, new Map([["fleet", {}]]), true);

		expect(predecessor).toHaveBeenCalledTimes(1);
		expect(container.clear).not.toHaveBeenCalled();
	});

	it("never touches the below-editor slot", () => {
		const predecessor = install(() => true);

		call(makeContainer(), new Map(), false, false);

		expect(predecessor).toHaveBeenCalledTimes(1);
	});

	it("forwards while disabled", () => {
		const predecessor = install(() => false);
		const container = makeContainer();

		call(container, new Map(), true);

		expect(predecessor).toHaveBeenCalledTimes(1);
		expect(container.clear).not.toHaveBeenCalled();
	});

	it("follows the predicate, so a config change applies on the next rebuild", () => {
		let enabled = true;
		const predecessor = install(() => enabled);

		call(makeContainer(), new Map(), true);
		expect(predecessor).not.toHaveBeenCalled();

		enabled = false;
		call(makeContainer(), new Map(), true);
		expect(predecessor).toHaveBeenCalledTimes(1);
	});

	it("restores the method it wrapped on dispose", () => {
		const predecessor = install(() => true);
		expect(prototype.renderWidgetContainer).not.toBe(predecessor);
		dispose?.();
		dispose = undefined;
		expect(prototype.renderWidgetContainer).toBe(predecessor);
	});
});
