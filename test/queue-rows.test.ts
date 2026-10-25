import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNativeQueueRowHiding } from "../extensions/starline/queue-rows";

/**
 * The wrapper is installed on Pi's real prototype but over a stub predecessor, so
 * the test can tell "cleared instead of rebuilt" from "forwarded" without
 * initializing Pi's theme. The original method is put back afterwards.
 */
type Host = {
	pendingMessagesContainer: { clear: () => void; addChild: (child: unknown) => void };
};

const prototype = InteractiveMode.prototype as unknown as {
	updatePendingMessagesDisplay: unknown;
};
const original = prototype.updatePendingMessagesDisplay;

let dispose: (() => void) | undefined;

afterEach(() => {
	dispose?.();
	dispose = undefined;
	prototype.updatePendingMessagesDisplay = original;
});

function install(enabled: () => boolean) {
	const predecessor = vi.fn();
	prototype.updatePendingMessagesDisplay = predecessor;
	dispose = installNativeQueueRowHiding(enabled);
	return predecessor;
}

function makeHost(): Host {
	return { pendingMessagesContainer: { clear: vi.fn(), addChild: vi.fn() } };
}

const call = (host: Host) =>
	(prototype.updatePendingMessagesDisplay as (this: Host) => void).call(host);

describe("hiding Pi's own queued-message rows", () => {
	it("clears the container instead of rebuilding it while enabled", () => {
		const predecessor = install(() => true);
		const host = makeHost();

		call(host);

		expect(host.pendingMessagesContainer.clear).toHaveBeenCalled();
		expect(predecessor).not.toHaveBeenCalled();
	});

	it("forwards to Pi while disabled", () => {
		const predecessor = install(() => false);
		const host = makeHost();

		call(host);

		expect(predecessor).toHaveBeenCalledTimes(1);
		expect(host.pendingMessagesContainer.addChild).not.toHaveBeenCalled();
	});

	it("follows the predicate, so a config change applies on the next update", () => {
		let enabled = true;
		const predecessor = install(() => enabled);

		call(makeHost());
		expect(predecessor).not.toHaveBeenCalled();

		enabled = false;
		call(makeHost());
		expect(predecessor).toHaveBeenCalledTimes(1);
	});

	it("restores the method it wrapped on dispose", () => {
		const predecessor = install(() => true);
		expect(prototype.updatePendingMessagesDisplay).not.toBe(predecessor);
		dispose?.();
		dispose = undefined;
		expect(prototype.updatePendingMessagesDisplay).toBe(predecessor);
	});
});
