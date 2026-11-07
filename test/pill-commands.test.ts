import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `extensionStatuses.commands` lets a status pill run a slash command — the short
 * way to open the panel its extension already has (`procs` → `/ps`).
 *
 * The order of the sources is what these tests pin: a built-in segment answers for
 * itself, a bridge beats the configured command, and the command is the fallback.
 * Only an extension command is ever sent: Pi treats an unmatched `/foo` as prompt
 * text, so a stale config would otherwise cost a model turn.
 */

const closePillBubble = vi.fn();

vi.mock("../extensions/starline/pill-bubble", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../extensions/starline/pill-bubble")>();
	// Only the close is spied on; bubble rendering keeps its own tests.
	return { ...actual, closePillBubble };
});

const { setActiveEditor } = await import("../extensions/starline/mouse/editor-mouse");
const { PILL_ACTIONS, pillActionFor, runPillAction, setPillCommandRunner } = await import(
	"../extensions/starline/pill-actions"
);
const { registerExternalPillAction } = await import("../extensions/starline/pill-api");

type Listed = { name: string; source: "extension" | "prompt" | "skill" };

const extension = (name: string): Listed => ({ name, source: "extension" });

function fakeContext() {
	const notify = vi.fn();
	return { notify, ctx: { hasUI: true, ui: { notify } } as never };
}

/** Install a runner whose config map and command list a test can name. */
function installRunner(commands: Record<string, string>, listed: Listed[]) {
	const send = vi.fn();
	setPillCommandRunner({
		commandFor: (key) => (Object.hasOwn(commands, key) ? commands[key] : undefined),
		list: () => listed,
		send,
	});
	return send;
}

afterEach(() => {
	setPillCommandRunner(undefined);
	setActiveEditor(undefined);
	closePillBubble.mockClear();
});

describe("a pill whose click runs a configured command", () => {
	it("sends the command an extension command resolves to", () => {
		const send = installRunner({ procs: "/ps" }, [extension("ps")]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).toHaveBeenCalledWith("/ps");
		expect(notify).not.toHaveBeenCalled();
	});

	it("closes an open bubble before the command takes the screen", () => {
		const send = installRunner({ procs: "/ps" }, [extension("ps")]);
		const { ctx } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(closePillBubble).toHaveBeenCalledTimes(1);
		expect(closePillBubble.mock.invocationCallOrder[0]).toBeLessThan(
			send.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
		);
	});

	it("is inert when no runner is installed", () => {
		expect(pillActionFor("procs")).toBeUndefined();
	});

	it("answers the same for the lowercased /starline argument", () => {
		installRunner({ procs: "/ps" }, [extension("ps")]);
		expect(pillActionFor("procs")).toBeTypeOf("function");
	});
});

describe("which source answers the click", () => {
	it("keeps a built-in segment on its own action", () => {
		const send = installRunner({ git: "/ps" }, [extension("ps")]);

		expect(pillActionFor("git")).toBe(PILL_ACTIONS.git);
		runPillAction(pillActionFor("git")!, fakeContext().ctx);
		expect(send).not.toHaveBeenCalled();
	});

	it("prefers a bridge registration over the configured command", () => {
		const send = installRunner({ procs: "/ps" }, [extension("ps")]);
		const bridge = vi.fn();
		const unregister = registerExternalPillAction("procs", bridge);

		expect(pillActionFor("procs")).toBe(bridge);
		runPillAction(pillActionFor("procs")!, fakeContext().ctx);
		expect(bridge).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();

		unregister();
	});

	it("hands the click back to the configured command when the bridge goes", () => {
		const send = installRunner({ procs: "/ps" }, [extension("ps")]);
		const unregister = registerExternalPillAction("procs", vi.fn());
		unregister();

		expect(pillActionFor("procs")).toBeTypeOf("function");
		runPillAction(pillActionFor("procs")!, fakeContext().ctx);
		expect(send).toHaveBeenCalledWith("/ps");
	});
});

describe("what a configured command may run", () => {
	it("refuses a command this session does not have", () => {
		const send = installRunner({ procs: "/nothing" }, [extension("ps")]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).not.toHaveBeenCalled();
		expect(notify.mock.calls[0]?.[0]).toContain("No /nothing command");
	});

	it("refuses a prompt template, which would start a turn", () => {
		const send = installRunner({ procs: "/review" }, [{ name: "review", source: "prompt" }]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).not.toHaveBeenCalled();
		expect(notify.mock.calls[0]?.[0]).toContain("prompt");
	});

	it("refuses a skill for the same reason", () => {
		const send = installRunner({ procs: "/commit" }, [{ name: "commit", source: "skill" }]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).not.toHaveBeenCalled();
		expect(notify.mock.calls[0]?.[0]).toContain("skill");
	});

	it("takes the extension command when a template shares its name", () => {
		const send = installRunner({ procs: "/review" }, [
			{ name: "review", source: "prompt" },
			extension("review"),
		]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).toHaveBeenCalledWith("/review");
		expect(notify).not.toHaveBeenCalled();
	});

	it("does nothing while a panel holds the editor slot", () => {
		// `/ps` and its kind replace the editor; a second click would clear the
		// component without disposing it, so the panel on screen is the answer.
		setActiveEditor({ component: { focused: false }, scrollable: {} });
		const send = installRunner({ procs: "/ps" }, [extension("ps")]);
		const { ctx, notify } = fakeContext();

		runPillAction(pillActionFor("procs")!, ctx);

		expect(send).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});
});
