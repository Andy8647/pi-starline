import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	buildTurnGraph,
	type GraphRow,
	relativeTime,
	renderTurnGraph,
	treePillText,
} from "../extensions/starline/tree-view";

type Manager = ExtensionContext["sessionManager"];

type FakeEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: { role: string; content: unknown };
	customType?: string;
	label?: string;
	timestamp?: string;
};

function user(id: string, text: string, parentId: string | null): FakeEntry {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistant(id: string, text: string, parentId: string | null): FakeEntry {
	return {
		type: "message",
		id,
		parentId,
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

/** A `custom` entry, which every extension writes after a turn. */
function custom(id: string, parentId: string | null): FakeEntry {
	return { type: "custom", id, parentId, customType: "test" };
}

function label(id: string, parentId: string | null, targetId: string, text: string): FakeEntry {
	return { type: "label", id, parentId, targetId, label: text } as FakeEntry & { targetId: string };
}

/**
 * The slice of `ReadonlySessionManager` the view uses. Cast at the end: the real
 * type carries the whole manager, and a fixture that implemented all of it would
 * be a second implementation to keep in sync.
 */
function fakeManager(entries: FakeEntry[], leafId: string): Manager {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const labels = new Map<string, string>();
	for (const entry of entries) {
		const target = (entry as { targetId?: string }).targetId;
		if (entry.type === "label" && target && entry.label) labels.set(target, entry.label);
	}
	const childrenOf = new Map<string | null, FakeEntry[]>();
	for (const entry of entries) {
		const siblings = childrenOf.get(entry.parentId) ?? [];
		siblings.push(entry);
		childrenOf.set(entry.parentId, siblings);
	}
	// Built without recursion, like Pi's own `getTree`, so a deep fixture works.
	type FakeNode = { entry: FakeEntry; label?: string; children: FakeNode[] };
	const nodes = new Map<string, FakeNode>();
	for (const entry of entries) {
		nodes.set(entry.id, { entry, label: labels.get(entry.id), children: [] });
	}
	for (const entry of entries) {
		const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
		if (parent) parent.children.push(nodes.get(entry.id) as FakeNode);
	}
	return {
		getLeafId: () => leafId,
		getEntry: (id: string) => byId.get(id),
		getBranch: (fromId?: string) => {
			const path: FakeEntry[] = [];
			let current = byId.get(fromId ?? leafId);
			while (current) {
				path.push(current);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			return path.reverse();
		},
		getTree: () => (childrenOf.get(null) ?? []).map((entry) => nodes.get(entry.id)),
		getLabel: (id: string) => labels.get(id),
	} as unknown as Manager;
}

function graphOf(entries: FakeEntry[], leafId: string) {
	const graph = buildTurnGraph(fakeManager(entries, leafId));
	if (!graph) throw new Error("expected a graph");
	return graph;
}

/** Rows without the dim on off-path turns, and without trailing padding. */
function plain(rows: readonly GraphRow[]): string[] {
	return rows.map((row) => row.text.replace(/\x1b\[\d+m/g, "").trimEnd());
}

/** u1 u2 u3 on the current path, and u2b forking after u1. */
function branchedSession(): FakeEntry[] {
	return [
		user("u1", "first question", null),
		assistant("a1", "first answer", "u1"),
		custom("c1", "a1"),
		user("u2", "second question", "c1"),
		assistant("a2", "second answer", "u2"),
		user("u3", "third question", "a2"),
		assistant("a3", "third answer", "u3"),
		user("u2b", "another second question", "c1"),
		assistant("a2b", "another second answer", "u2b"),
	];
}

describe("buildTurnGraph", () => {
	it("keeps only the turns you wrote, each under the one before it", () => {
		const graph = buildTurnGraph(fakeManager(branchedSession(), "a3"));
		expect(graph?.roots.map((turn) => turn.text)).toEqual(["first question"]);
		const first = graph?.roots[0];
		expect(first?.children.map((turn) => turn.text)).toEqual([
			"second question",
			"another second question",
		]);
		expect(graph?.tips).toBe(2);
	});

	it("marks the current path and where the session is", () => {
		const graph = buildTurnGraph(fakeManager(branchedSession(), "a3"));
		const [main, other] = graph?.roots[0]?.children ?? [];
		expect(main?.onPath).toBe(true);
		expect(other?.onPath).toBe(false);
		expect(main?.children[0]?.here).toBe(true);
		expect(main?.here).toBe(false);
	});

	it("ends each branch on its last entry, with how many turns it ran", () => {
		const graph = buildTurnGraph(fakeManager(branchedSession(), "a3"));
		const other = graph?.roots[0]?.children[1];
		expect(other?.tip).toMatchObject({ leafId: "a2b", turns: 2 });
	});

	it("does not count a label appended at the leaf as a second branch", () => {
		const entries = [
			...branchedSession(),
			label("l1", "a3", "u3", "checkpoint"),
			custom("c9", "l1"),
		];
		const graph = buildTurnGraph(fakeManager(entries, "c9"));
		expect(graph?.tips).toBe(2);
		expect(graph?.label).toBe("checkpoint");
	});

	it("treats a rewind to an earlier turn as being on that turn", () => {
		// The session moved back to a2 and nothing has been sent since: u2 is where
		// it is, and u3 is now a branch it left.
		const graph = buildTurnGraph(fakeManager(branchedSession(), "a2"));
		const main = graph?.roots[0]?.children[0];
		expect(main?.here).toBe(true);
		expect(main?.children[0]?.onPath).toBe(false);
		expect(treePillText(graph, "⑂")).toBe("⑂ +1");
	});

	it("orders branches oldest first", () => {
		const entries = branchedSession().map((entry) =>
			entry.id === "u2"
				? { ...entry, timestamp: "2026-11-02T10:00:00Z" }
				: entry.id === "u2b"
					? { ...entry, timestamp: "2026-11-02T09:00:00Z" }
					: entry,
		);
		const graph = buildTurnGraph(fakeManager(entries, "a3"));
		expect(graph?.roots[0]?.children.map((turn) => turn.entryId)).toEqual(["u2b", "u2"]);
	});

	it("has nothing to show before the first message", () => {
		expect(buildTurnGraph(fakeManager([], ""))).toBeUndefined();
		expect(buildTurnGraph(fakeManager([custom("c0", null)], "c0"))).toBeUndefined();
	});
});

describe("buildTurnGraph on unusual sessions", () => {
	it("walks a session far deeper than the call stack allows", () => {
		const entries: FakeEntry[] = [];
		let parent: string | null = null;
		// Two turns, with five thousand tool results between them.
		entries.push(user("u1", "start", parent));
		parent = "u1";
		for (let step = 0; step < 5_000; step += 1) {
			entries.push(custom(`t${step}`, parent));
			parent = `t${step}`;
		}
		entries.push(user("u2", "and then", parent));
		const graph = graphOf(entries, "u2");
		expect(graph.roots[0]?.children[0]?.text).toBe("and then");
		expect(graph.tips).toBe(1);
	});

	it("keeps a message that is only an image as a turn", () => {
		const image = {
			type: "message",
			id: "u2",
			parentId: "a1",
			message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] },
		} as FakeEntry;
		const graph = graphOf([user("u1", "look", null), assistant("a1", "ok", "u1"), image], "u2");
		expect(graph.roots[0]?.children[0]).toMatchObject({ text: "[image]", here: true });
	});

	it("still draws the tree when the session is on none of it", () => {
		const graph = graphOf(branchedSession(), "");
		expect(graph.tips).toBe(2);
		expect(plain(renderTurnGraph(graph, 40)).some((row) => row.includes("← here"))).toBe(false);
	});
});

describe("treePillText", () => {
	it("is the icon alone for one straight conversation", () => {
		const entries = branchedSession().filter((entry) => !entry.id.endsWith("b"));
		expect(treePillText(buildTurnGraph(fakeManager(entries, "a3")), "⑂")).toBe("⑂");
	});

	it("counts the other branches and names the current one by its label", () => {
		const entries = [...branchedSession(), label("l1", "a3", "u2", "plan A")];
		expect(treePillText(buildTurnGraph(fakeManager(entries, "l1")), "⑂")).toBe("⑂ plan A +1");
	});
});

describe("renderTurnGraph", () => {
	it("hangs branches off ├─ / └─ and lines up the rest of each branch with its first turn", () => {
		const rows = renderTurnGraph(graphOf(branchedSession(), "a3"), 60);
		expect(plain(rows)).toEqual([
			"● first question",
			"├─ ● second question",
			"│  ● third question                                   ← here",
			"└─ ○ another second question                         2 turns",
		]);
	});

	it("keeps a straight conversation in one column", () => {
		const entries = branchedSession().filter((entry) => !entry.id.endsWith("b"));
		expect(plain(renderTurnGraph(graphOf(entries, "a3"), 30))).toEqual([
			"● first question",
			"● second question",
			"● third question        ← here",
		]);
	});

	it("hangs a fork inside a branch under the turn it forks from", () => {
		const entries = [
			...branchedSession(),
			user("u3b", "another third question", "a2"),
			assistant("a3b", "another third answer", "u3b"),
		];
		expect(plain(renderTurnGraph(graphOf(entries, "a3"), 44))).toEqual([
			"● first question",
			"├─ ● second question",
			"│  ├─ ● third question                ← here",
			"│  └─ ○ another third question       3 turns",
			"└─ ○ another second question         2 turns",
		]);
	});

	it("hangs several first messages off the session start, as /tree does", () => {
		const entries = [
			user("u1", "one", null),
			assistant("a1", "reply", "u1"),
			user("u2", "two", null),
			assistant("a2", "reply", "u2"),
		];
		const rows = renderTurnGraph(graphOf(entries, "a2"), 30);
		expect(plain(rows)).toEqual([
			"◇ session start",
			"├─ ○ one                1 turn",
			"└─ ● two                ← here",
		]);
		expect(rows[0]?.entryId).toBeUndefined();
	});

	it("opens a turn on itself, another branch on its end, and the current turn nowhere", () => {
		const rows = renderTurnGraph(graphOf(branchedSession(), "a3"), 60);
		expect(rows.map((row) => row.entryId)).toEqual(["u1", "u2", undefined, "a2b"]);
	});

	it("dims the turns off the current path", () => {
		const rows = renderTurnGraph(graphOf(branchedSession(), "a3"), 60);
		expect(rows[3]?.text.startsWith("\x1b[2m")).toBe(true);
		expect(rows[0]?.text.startsWith("\x1b[2m")).toBe(false);
	});

	it("folds the middle of a long straight run, keeping its ends and labels", () => {
		const entries: FakeEntry[] = [];
		let parent: string | null = null;
		for (let turn = 1; turn <= 9; turn += 1) {
			entries.push(user(`u${turn}`, `turn ${turn}`, parent));
			entries.push(assistant(`a${turn}`, `reply ${turn}`, `u${turn}`));
			parent = `a${turn}`;
		}
		entries.push(label("l1", "a9", "u5", "midpoint"));
		const rows = renderTurnGraph(graphOf(entries, "l1"), 40);
		expect(plain(rows)).toEqual([
			"● turn 1",
			"⋮ 3 turns",
			"● turn 5 [midpoint]",
			"⋮ 2 turns",
			"● turn 8",
			"● turn 9                          ← here",
		]);
	});

	it("leaves no reset in a cut row, so dim and the hover fill reach its end", () => {
		const long = branchedSession().map((entry) =>
			entry.id === "u2b" ? user("u2b", "很长的中文问题".repeat(20), "c1") : entry,
		);
		for (const row of renderTurnGraph(graphOf(long, "a3"), 50)) {
			expect(row.text).not.toContain("\x1b[0m");
		}
	});

	it("keeps every row to the width it was given", () => {
		const long = branchedSession().map((entry) =>
			entry.id === "u2b" ? user("u2b", "很长的中文问题".repeat(20), "c1") : entry,
		);
		for (const row of renderTurnGraph(graphOf(long, "a3"), 50)) {
			expect(visibleWidth(row.text)).toBe(50);
		}
	});
});

describe("relativeTime", () => {
	const now = Date.parse("2026-11-28T12:00:00Z");
	it("says how long ago a branch was last written to", () => {
		expect(relativeTime("2026-11-28T11:59:40Z", now)).toBe("just now");
		expect(relativeTime("2026-11-28T11:15:00Z", now)).toBe("45m ago");
		expect(relativeTime("2026-11-28T07:00:00Z", now)).toBe("5h ago");
		expect(relativeTime("2026-11-20T12:00:00Z", now)).toBe("8d ago");
		expect(relativeTime(undefined, now)).toBeUndefined();
	});
});
