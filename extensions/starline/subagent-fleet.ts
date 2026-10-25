/**
 * What `pi-subagents` is running right now, read through its public RPC.
 *
 * `pi-subagents` publishes no status pill of its own; it draws FleetView and a
 * widget. What it does publish is a versioned, in-process RPC on `pi.events`
 * (`subagents:rpc:v1`, see its `docs/extension-api.md`): an untargeted `status`
 * request answers from in-memory state with a bounded `fleet` record — the active
 * runs, foreground and background, each with its agent, model and start time.
 * That is a contract, not an internal, so Starline reads it instead of anything
 * the package keeps privately.
 *
 * The count is refreshed when something can have changed it: the package's own
 * lifecycle events, and Pi's tool events for the `subagent` tool (a foreground run
 * starts with no event of its own). Never on a timer. Without `pi-subagents` the
 * requests simply go unanswered, the count stays 0 and the pill never appears.
 */

import type { SubagentsFormat } from "./config";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const READY_EVENT = "subagents:rpc:v1:ready";
const REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

/** `pi-subagents` events after which the set of active runs may differ. */
const CHANGE_EVENTS = [
	"subagent:async-started",
	"subagent:async-complete",
	"subagent:foreground-complete",
	"subagent:process-terminal",
	"subagent:child-status",
	"subagent:control-event",
];

/** The tool whose start and end bracket a foreground run. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** Long enough for a loaded event loop, short enough not to pile up listeners. */
const REFRESH_TIMEOUT_MS = 2_000;
/** Bursts of child events collapse into one request. */
const REFRESH_DELAY_MS = 150;

export type EventBusLike = {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
};

export type FleetEntry = {
	agent: string;
	role?: string;
	model?: string;
	effort?: string;
	/** Epoch milliseconds. */
	startedAt: number;
	tokens: number;
};

export type FleetSnapshot = {
	totalActive: number;
	entries: FleetEntry[];
	/** Active runs beyond the entries the package chose to list. */
	omitted: number;
};

export const EMPTY_FLEET: FleetSnapshot = { totalActive: 0, entries: [], omitted: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Read a `status` reply's `data.fleet`. Anything unexpected is dropped rather than
 * trusted: the DTO is versioned, and the package's docs ask clients to ignore
 * fields they do not know.
 */
export function parseFleet(reply: unknown): FleetSnapshot | undefined {
	if (!isRecord(reply) || reply.success !== true || !isRecord(reply.data)) return undefined;
	const fleet = reply.data.fleet;
	if (!isRecord(fleet) || fleet.version !== 1 || !Array.isArray(fleet.entries)) return undefined;

	const entries: FleetEntry[] = [];
	for (const raw of fleet.entries) {
		if (!isRecord(raw)) continue;
		const agent = optionalText(raw.agent);
		const startedAt = raw.startedAt;
		if (!agent || typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;
		entries.push({
			agent,
			role: optionalText(raw.role),
			model: optionalText(raw.model),
			effort: optionalText(raw.effort),
			startedAt,
			tokens: isRecord(raw.tokens) ? count(raw.tokens.total) : 0,
		});
	}
	return {
		totalActive: Math.max(count(fleet.totalActive), entries.length),
		entries,
		omitted: count(fleet.omitted),
	};
}

export type SubagentFleet = {
	/** The last answer, or the empty fleet before any. */
	snapshot(): FleetSnapshot;
	/** Whether `pi-subagents` has ever answered or announced itself. */
	available(): boolean;
	/** Ask again soon; bursts collapse into one request. */
	refresh(): void;
	/** Ask now and wait for the answer, for a bubble that wants fresh numbers. */
	fetch(timeoutMs?: number): Promise<FleetSnapshot | undefined>;
	dispose(): void;
};

/**
 * Track the fleet on `bus`. `onChange` runs when the number of active runs
 * changes, which is all the pill shows; the bubble fetches its own fresh copy.
 */
export function createSubagentFleet(
	bus: EventBusLike,
	options: { onChange: () => void; delayMs?: number },
): SubagentFleet {
	const delayMs = options.delayMs ?? REFRESH_DELAY_MS;
	let snapshot = EMPTY_FLEET;
	let available = false;
	let disposed = false;
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;
	let again = false;
	let nextRequest = 0;
	const pending = new Set<() => void>();

	const fetch = (timeoutMs = REFRESH_TIMEOUT_MS): Promise<FleetSnapshot | undefined> =>
		new Promise((resolve) => {
			if (disposed) {
				resolve(undefined);
				return;
			}
			nextRequest += 1;
			const requestId = `starline-fleet-${process.pid}-${Date.now()}-${nextRequest}`;
			let unsubscribe: () => void = () => {};
			const finish = (result: FleetSnapshot | undefined) => {
				clearTimeout(timer);
				unsubscribe();
				pending.delete(cancel);
				if (result) {
					available = true;
					const changed = result.totalActive !== snapshot.totalActive;
					snapshot = result;
					if (changed) options.onChange();
				}
				resolve(result);
			};
			const cancel = () => finish(undefined);
			const timer = setTimeout(cancel, timeoutMs);
			pending.add(cancel);
			try {
				unsubscribe = bus.on(`${REPLY_EVENT_PREFIX}${requestId}`, (reply) =>
					finish(parseFleet(reply)),
				);
				bus.emit(REQUEST_EVENT, { version: 1, requestId, method: "status", params: {} });
			} catch {
				finish(undefined);
			}
		});

	const run = () => {
		scheduled = undefined;
		if (disposed) return;
		inFlight = true;
		void fetch().finally(() => {
			inFlight = false;
			if (again) {
				again = false;
				refresh();
			}
		});
	};

	const refresh = () => {
		if (disposed) return;
		if (inFlight) {
			again = true;
			return;
		}
		if (scheduled === undefined) scheduled = setTimeout(run, delayMs);
	};

	const unsubscribers: Array<() => void> = [];
	try {
		unsubscribers.push(
			bus.on(READY_EVENT, () => {
				available = true;
				refresh();
			}),
		);
		for (const channel of CHANGE_EVENTS) unsubscribers.push(bus.on(channel, refresh));
	} catch {
		// A bus that refuses listeners leaves the pill off, which is the same as no
		// pi-subagents at all.
	}

	return {
		snapshot: () => snapshot,
		available: () => available,
		refresh,
		fetch,
		dispose() {
			disposed = true;
			if (scheduled !== undefined) clearTimeout(scheduled);
			for (const unsubscribe of unsubscribers) unsubscribe();
			for (const cancel of [...pending]) cancel();
			snapshot = EMPTY_FLEET;
		},
	};
}

/**
 * The fleet the footer and the pill action read. One per Starline instance, set
 * at session start like the other session-scoped singletons.
 */
let activeFleet: SubagentFleet | undefined;

export function setActiveSubagentFleet(fleet: SubagentFleet | undefined): void {
	activeFleet?.dispose();
	activeFleet = fleet;
}

export function getActiveSubagentFleet(): SubagentFleet | undefined {
	return activeFleet;
}

/** The pill's text: how many are running, or nothing so the pill is not drawn. */
export function subagentsSegmentText(format: SubagentsFormat = "agents"): string {
	const total = activeFleet?.snapshot().totalActive ?? 0;
	if (total <= 0) return "";
	if (format === "count") return `${total}`;
	return `${total} agent${total === 1 ? "" : "s"}`;
}
