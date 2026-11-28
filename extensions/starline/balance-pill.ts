/**
 * The `balance` pill: when it asks, what it says, and its bubble.
 *
 * It asks only while the pill is in the bar — reading a balance means sending the
 * model's key to the provider's account endpoint, and a user who has not put the
 * pill there has not asked for that. Then it asks on the first render, when the
 * model changes, and after each turn, at most once a minute for the same account.
 * A model on another account asks at once and drops the old number, since that
 * number was someone else's.
 *
 * Codex also reports its windows in headers on every model response that goes
 * over HTTP; those update the pill for free and count as a check. Pi's default
 * Codex transport is a WebSocket, which has no such headers, so the endpoint is
 * still how the pill learns them there.
 */

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PillAnchor, PillBubbleLine } from "../../types/pill-api";
import {
	type BalanceAmount,
	type BalanceReading,
	type BalanceSource,
	type BalanceWindow,
	balanceSourceFor,
	fetchBalance,
	readCodexHeaders,
} from "./balance";
import { showPillBubble } from "./pill-bubble";

type Host = {
	/** Whether the pill is in the bar, which is what allows a request at all. */
	isEnabled: () => boolean;
	/** Repaint the footer. */
	requestRender: () => void;
};

type Check = { reading: BalanceReading; at: number };

type State = {
	/**
	 * Who the numbers belong to: the provider, its endpoint and a hash of the
	 * credential. Two DeepSeek keys share an endpoint and are still two accounts.
	 */
	account?: string;
	source?: BalanceSource;
	current?: Check;
	/** The check before `current`, on the same account, for the change since. */
	previous?: Check;
	/**
	 * When a check last started, whether or not it found a provider. Set either way,
	 * so the render that starts the first check does not start one per frame.
	 */
	lastAttempt?: number;
};

/** Same account, same question: once a minute is plenty. */
const MIN_INTERVAL_MS = 60_000;
const BAR = 10;

let host: Host | undefined;
let state: State = {};
/** Bumped by `resetBalance`, so a request that outlives its session lands nowhere. */
let generation = 0;
let inFlight: Promise<void> | undefined;
/**
 * A check asked for while another ran: a model switch mid-request must not be
 * lost, or the pill keeps the old account's number until the next turn.
 */
let pending: { ctx: ExtensionContext; force: boolean } | undefined;

export function setBalanceHost(next: Host | undefined): void {
	host = next;
}

/** Forget everything. Session start and shutdown. */
export function resetBalance(): void {
	state = {};
	pending = undefined;
	generation += 1;
}

/**
 * The credential Pi would send: an API key, or the bearer token an OAuth
 * provider puts in `Authorization` instead (Kimi's subscription sign-in does).
 */
function credentialOf(auth: {
	apiKey?: string;
	headers?: Record<string, unknown>;
}): string | undefined {
	if (auth.apiKey) return auth.apiKey;
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
		const token = /^Bearer\s+(.+)$/i.exec(value.trim())?.[1];
		if (token) return token;
	}
	return undefined;
}

async function accountFor(
	ctx: ExtensionContext,
): Promise<{ source: BalanceSource; apiKey: string; account: string } | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const source = balanceSourceFor(model.baseUrl);
	// Nothing to ask an unknown provider, so its credential is not even resolved.
	if (!source) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	// Pi sends the request to `auth.baseUrl` when the credential carries one; the
	// account endpoint has to be on that same host.
	const target = auth.baseUrl ? balanceSourceFor(auth.baseUrl) : source;
	const apiKey = credentialOf(auth);
	if (!target || !apiKey) return undefined;
	const hash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
	return { source: target, apiKey, account: `${model.provider}|${target.url}|${hash}` };
}

/**
 * Check the balance of the account the current model bills to. `force` skips the
 * once-a-minute limit; a change of account always does.
 */
export async function refreshBalance(ctx: ExtensionContext, force = false): Promise<void> {
	if (!host?.isEnabled()) return;
	if (inFlight) {
		pending = { ctx, force: force || (pending?.force ?? false) };
		return;
	}
	const started = generation;
	const run = (async () => {
		const now = Date.now();
		let resolved: Awaited<ReturnType<typeof accountFor>>;
		try {
			resolved = await accountFor(ctx);
		} catch {
			resolved = undefined;
		}
		if (started !== generation) return;
		if (!resolved) {
			// Not a provider this knows, or no credential: nothing to show.
			const shown = state.source !== undefined;
			state = { lastAttempt: now };
			if (shown) host?.requestRender();
			return;
		}
		const { source, apiKey, account } = resolved;
		const sameAccount = state.account === account;
		if (sameAccount && !force && state.lastAttempt && now - state.lastAttempt < MIN_INTERVAL_MS) {
			return;
		}
		if (!sameAccount) {
			state = { account, source };
			host?.requestRender();
		}
		state.lastAttempt = now;
		const reading = await fetchBalance(source, apiKey);
		if (started !== generation || state.account !== account) return;
		// A failed check keeps the last number: a blip should not empty the pill.
		if (!reading) return;
		record(reading, Date.now());
	})();
	inFlight = run;
	try {
		await run;
	} finally {
		inFlight = undefined;
		const next = pending;
		pending = undefined;
		if (next && started === generation) void refreshBalance(next.ctx, next.force);
	}
}

function record(reading: BalanceReading, at: number): void {
	const last = state.current?.reading;
	// Codex's headers carry the windows but not the plan; keep the plan the endpoint
	// reported rather than dropping it from the bubble's title on every turn.
	if (reading.kind === "quota" && !reading.plan && last?.kind === "quota" && last.plan) {
		reading = { ...reading, plan: last.plan };
	}
	if (state.current) state.previous = state.current;
	state.current = { reading, at };
	host?.requestRender();
}

/**
 * Read Codex's usage headers off a model response, when the model is on Codex.
 * They are the same windows the endpoint reports, so they count as a check.
 */
export function observeBalanceHeaders(headers: Record<string, string>): void {
	if (!host?.isEnabled() || state.source?.id !== "codex") return;
	const now = Date.now();
	const reading = readCodexHeaders(headers, now);
	if (!reading) return;
	state.lastAttempt = now;
	record(reading, now);
}

// ---- Formatting -----------------------------------------------------------------

const SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", GBP: "£" };

function money(amount: number, currency: string): string {
	// Below a cent is zero, so a rounding remainder never reads as `-$0.00`.
	const value = Math.abs(amount) < 0.005 ? 0 : amount;
	const digits = Math.abs(value).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	const sign = value < 0 ? "-" : "";
	const symbol = SYMBOLS[currency];
	return symbol ? `${sign}${symbol}${digits}` : `${sign}${digits} ${currency}`;
}

/** The amount the pill shows: the first currency with money in it. */
function headline(amounts: readonly BalanceAmount[]): BalanceAmount | undefined {
	return amounts.find((amount) => amount.total !== 0) ?? amounts[0];
}

function left(window: BalanceWindow): number {
	return Math.round(100 - window.usedPercent);
}

export function balancePillText(reading: BalanceReading | undefined, icon: string): string {
	if (!reading) return "";
	let text: string;
	if (reading.kind === "money") {
		const amount = headline(reading.amounts);
		if (!amount) return "";
		text = money(amount.total, amount.currency);
	} else {
		text = reading.windows.map((window) => `${window.label} ${left(window)}%`).join(" · ");
	}
	return icon ? `${icon} ${text}` : text;
}

/** What the footer shows. Empty means "leave the pill out". */
export function balancePillLabel(ctx: ExtensionContext, icon: string): string {
	// The first render after the pill is added is what starts the first check, so
	// adding it in `/starline` shows a number without waiting for the next turn.
	if (!state.lastAttempt && !inFlight) void refreshBalance(ctx);
	return balancePillText(state.current?.reading, icon);
}

export function relativeDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function bar(usedPercent: number): string {
	const filled = Math.round(((100 - usedPercent) / 100) * BAR);
	return `${"█".repeat(filled)}${"░".repeat(BAR - filled)}`;
}

/** The bubble's lines for a reading; exported for tests. */
export function balanceBubbleLines(
	current: Check,
	previous: Check | undefined,
	now: number,
): string[] {
	const lines: string[] = [];
	const { reading } = current;
	if (reading.kind === "money") {
		const width = Math.max(...reading.amounts.map((amount) => amount.currency.length));
		const shown = reading.amounts.filter((amount) => amount.total !== 0);
		for (const amount of shown.length > 0 ? shown : reading.amounts.slice(0, 1)) {
			let line = `${amount.currency.padEnd(width)}  ${money(amount.total, amount.currency)}`;
			const before =
				previous?.reading.kind === "money"
					? previous.reading.amounts.find((entry) => entry.currency === amount.currency)
					: undefined;
			const change = before ? amount.total - before.total : 0;
			if (before && Math.abs(change) >= 0.005) {
				line += `  ${change < 0 ? "▼" : "▲"} ${money(Math.abs(change), amount.currency)} since ${relativeDuration(now - (previous?.at ?? now))} ago`;
			}
			lines.push(line);
			if (amount.parts) {
				const parts = amount.parts.map(
					(part) => `${part.label} ${money(part.amount, amount.currency)}`,
				);
				lines.push(`${" ".repeat(width + 2)}${parts.join(" · ")}`);
			}
		}
	} else {
		const width = Math.max(...reading.windows.map((window) => window.label.length));
		for (const window of reading.windows) {
			const reset = window.resetsAt
				? ` · resets in ${relativeDuration(window.resetsAt - now)}`
				: "";
			lines.push(
				`${window.label.padEnd(width)}  ${bar(window.usedPercent)}  ${left(window)}% left${reset}`,
			);
		}
	}
	return lines;
}

/** Open the balance bubble. */
export function showBalanceBubble(ctx: ExtensionContext, pill?: PillAnchor): void {
	const source = state.source;
	const current = state.current;
	if (!source || !current) {
		ctx.ui.notify(
			source ? "Checking the balance…" : "No balance to show for this model's provider",
			"info",
		);
		return;
	}
	const now = Date.now();
	const plan =
		current.reading.kind === "quota" && current.reading.plan ? ` · ${current.reading.plan}` : "";
	const kind = current.reading.kind === "money" ? "balance" : "usage";
	const body: PillBubbleLine[] = balanceBubbleLines(current, state.previous, now);
	body.push("", {
		text: "▸ Check again",
		onSelect: () => void refreshBalance(ctx, true),
	});
	showPillBubble(
		ctx,
		{
			title: `${source.name} ${kind}${plan}`,
			body,
			hint: `checked ${relativeDuration(now - current.at)} ago`,
		},
		pill,
	);
}
