/**
 * What is left on the account the current model bills to.
 *
 * Pi only learns about money or quota when a request fails for the lack of it,
 * so this asks each provider's own account endpoint. The provider is recognised
 * from the model's base URL, not its name: a custom provider pointed at
 * `api.deepseek.com` is DeepSeek, and the key only ever goes to the host the model
 * already sends it to.
 *
 * Two kinds of answer come back. Pay-as-you-go accounts have money (DeepSeek,
 * Moonshot, OpenRouter); subscriptions have usage windows that reset (Codex, the
 * Kimi coding plan). Every parser reads by field, and a missing or mistyped field
 * means "not recognised": the pill then hides instead of showing a 0 that is not
 * there. These endpoints are not versioned, and that is the only defence against
 * one changing shape.
 */

/** Money in one currency, with what it is made of when the provider says. */
export type BalanceAmount = {
	currency: string;
	total: number;
	parts?: Array<{ label: string; amount: number }>;
};

/** A usage window of a subscription. */
export type BalanceWindow = {
	/** `5h`, `7d`: the length of the window. */
	label: string;
	/** 0–100. */
	usedPercent: number;
	/** Epoch milliseconds the window resets at, when known. */
	resetsAt?: number;
};

export type BalanceReading =
	| { kind: "money"; amounts: BalanceAmount[] }
	| { kind: "quota"; windows: BalanceWindow[]; plan?: string };

export type BalanceProviderId = "deepseek" | "moonshot" | "openrouter" | "kimi-coding" | "codex";

export type BalanceSource = {
	id: BalanceProviderId;
	/** How the provider is named in the bubble. */
	name: string;
	/** The account endpoint, on the model's own host. */
	url: string;
	/** Currency the provider bills in, for endpoints that do not say. */
	currency?: string;
};

type Fetch = (
	url: string,
	init: { headers: Record<string, string>; redirect?: "error"; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

const TIMEOUT_MS = 10_000;
/** Longer than any usage window these providers have (Kimi's and Codex's are a week). */
const MAX_RESET_MS = 35 * 86_400_000;

/**
 * Which provider a model bills to, from its base URL. `undefined` for anything
 * else, including a proxy in front of a known provider: its account endpoint is
 * not the provider's.
 */
export function balanceSourceFor(baseUrl: string | undefined): BalanceSource | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl ?? "");
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	const host = url.hostname.toLowerCase();
	const path = url.pathname.replace(/\/+$/, "");
	if (host === "api.deepseek.com") {
		return { id: "deepseek", name: "DeepSeek", url: `${url.origin}/user/balance` };
	}
	if (host === "api.moonshot.cn" || host === "api.moonshot.ai") {
		return {
			id: "moonshot",
			name: "Moonshot",
			url: `${url.origin}/v1/users/me/balance`,
			currency: host.endsWith(".cn") ? "CNY" : "USD",
		};
	}
	if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
		return {
			id: "openrouter",
			name: "OpenRouter",
			// `/credits` answers management keys only; `/key` answers the key in use.
			url: `${url.origin}/api/v1/key`,
			currency: "USD",
		};
	}
	if (host === "api.kimi.com" && path.startsWith("/coding")) {
		return { id: "kimi-coding", name: "Kimi Coding", url: `${url.origin}${path}/usages` };
	}
	if (host === "chatgpt.com" && path.startsWith("/backend-api")) {
		return { id: "codex", name: "Codex", url: `${url.origin}/backend-api/wham/usage` };
	}
	return undefined;
}

/**
 * The ChatGPT account a Codex token belongs to. The usage endpoint wants it as a
 * header, and Pi reads it from the same claim of the same token.
 */
export function codexAccountId(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Ask the provider. Resolves `undefined` when the account cannot be read: no key,
 * a refused request, a timeout, or an answer this does not recognise.
 */
export async function fetchBalance(
	source: BalanceSource,
	apiKey: string,
	options: { fetch?: Fetch; now?: number } = {},
): Promise<BalanceReading | undefined> {
	const doFetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json",
	};
	if (source.id === "codex") {
		const account = codexAccountId(apiKey);
		if (!account) return undefined;
		headers["chatgpt-account-id"] = account;
	}
	let body: unknown;
	try {
		// A redirect would carry the account headers to wherever it points.
		const response = await doFetch(source.url, {
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		body = await response.json();
	} catch {
		return undefined;
	}
	return parseBalance(source, body, options.now ?? Date.now());
}

export function parseBalance(
	source: BalanceSource,
	body: unknown,
	now: number,
): BalanceReading | undefined {
	switch (source.id) {
		case "deepseek":
			return parseDeepSeek(body);
		case "moonshot":
			return parseMoonshot(body, source.currency ?? "CNY");
		case "openrouter":
			return parseOpenRouter(body);
		case "kimi-coding":
			return parseKimiCoding(body, now);
		case "codex":
			return parseCodex(body, now);
	}
}

/** Codex's usage headers, which ride every model response that goes over HTTP. */
export function readCodexHeaders(
	headers: Record<string, string>,
	now: number,
): BalanceReading | undefined {
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
	const windows: BalanceWindow[] = [];
	for (const slot of ["primary", "secondary"]) {
		const used = number(lower[`x-codex-${slot}-used-percent`]);
		const minutes = number(lower[`x-codex-${slot}-window-minutes`]);
		if (used === undefined || minutes === undefined) continue;
		const resetAt = number(lower[`x-codex-${slot}-reset-at`]);
		windows.push(
			window(minutes * 60, used, resetAt !== undefined ? resetAt * 1000 : undefined, now),
		);
	}
	return windows.length > 0 ? { kind: "quota", windows } : undefined;
}

// ---- Parsers ---------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A finite number from a number or a numeric string: these endpoints send both. */
function number(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** `{"is_available":true,"balance_infos":[{"currency","total_balance","granted_balance","topped_up_balance"}]}` */
function parseDeepSeek(body: unknown): BalanceReading | undefined {
	const infos = record(body)?.balance_infos;
	if (!Array.isArray(infos)) return undefined;
	const amounts: BalanceAmount[] = [];
	for (const info of infos) {
		const entry = record(info);
		const currency = entry?.currency;
		const total = number(entry?.total_balance);
		if (typeof currency !== "string" || total === undefined) continue;
		const granted = number(entry?.granted_balance);
		const toppedUp = number(entry?.topped_up_balance);
		const parts: Array<{ label: string; amount: number }> = [];
		if (granted !== undefined) parts.push({ label: "granted", amount: granted });
		if (toppedUp !== undefined) parts.push({ label: "topped up", amount: toppedUp });
		amounts.push({ currency, total, ...(parts.length > 0 && { parts }) });
	}
	return moneyReading(amounts);
}

/** `{"code":0,"data":{"available_balance","voucher_balance","cash_balance"},"status":true}` */
function parseMoonshot(body: unknown, currency: string): BalanceReading | undefined {
	const data = record(record(body)?.data);
	const total = number(data?.available_balance);
	if (total === undefined) return undefined;
	const parts: Array<{ label: string; amount: number }> = [];
	const voucher = number(data?.voucher_balance);
	const cash = number(data?.cash_balance);
	if (voucher !== undefined) parts.push({ label: "voucher", amount: voucher });
	if (cash !== undefined) parts.push({ label: "cash", amount: cash });
	return { kind: "money", amounts: [{ currency, total, ...(parts.length > 0 && { parts }) }] };
}

/**
 * `{"data":{"limit","usage","limit_remaining",…}}` for the key in use, in US
 * dollars. A key without a credit limit has nothing left to count down
 * (`limit_remaining: null`), so there is no balance to show.
 */
function parseOpenRouter(body: unknown): BalanceReading | undefined {
	const data = record(record(body)?.data);
	const remaining = number(data?.limit_remaining);
	if (remaining === undefined) return undefined;
	const parts: Array<{ label: string; amount: number }> = [];
	const limit = number(data?.limit);
	const usage = number(data?.usage);
	if (limit !== undefined) parts.push({ label: "limit", amount: limit });
	if (usage !== undefined) parts.push({ label: "used", amount: usage });
	return {
		kind: "money",
		amounts: [{ currency: "USD", total: remaining, ...(parts.length > 0 && { parts }) }],
	};
}

/**
 * `{"usage":{limit,used|remaining,resetTime},"limits":[{"window":{duration,timeUnit},"detail":{…}}]}`.
 * The top-level `usage` is the plan's weekly allowance; `limits` are the shorter
 * windows. Either may be missing.
 */
function parseKimiCoding(body: unknown, now: number): BalanceReading | undefined {
	const root = record(body);
	if (!root) return undefined;
	const windows: BalanceWindow[] = [];
	const limits = Array.isArray(root.limits) ? root.limits : [];
	for (const item of limits) {
		const entry = record(item);
		const detail = record(entry?.detail) ?? entry;
		const span = record(entry?.window) ?? entry;
		const seconds = durationSeconds(
			span?.duration ?? detail?.duration,
			span?.timeUnit ?? detail?.timeUnit,
		);
		const used = usedPercent(detail);
		if (seconds === undefined || used === undefined) continue;
		windows.push(window(seconds, used, resetTime(detail), now));
	}
	const weekly = record(root.usage);
	const weeklyUsed = usedPercent(weekly);
	// The plan's weekly allowance, unless `limits` already listed a 7-day window.
	if (weeklyUsed !== undefined && !windows.some((entry) => entry.label === "7d")) {
		windows.push(window(7 * 86_400, weeklyUsed, resetTime(weekly), now));
	}
	return windows.length > 0 ? { kind: "quota", windows } : undefined;
}

function durationSeconds(duration: unknown, unit: unknown): number | undefined {
	const value = number(duration);
	if (value === undefined || value <= 0 || typeof unit !== "string") return undefined;
	if (unit.includes("MINUTE")) return value * 60;
	if (unit.includes("HOUR")) return value * 3600;
	if (unit.includes("DAY")) return value * 86_400;
	if (unit.includes("SECOND")) return value;
	return undefined;
}

/** Percent used, from `used` or `remaining` against `limit`. */
function usedPercent(detail: Record<string, unknown> | undefined): number | undefined {
	const limit = number(detail?.limit);
	if (limit === undefined || limit <= 0) return undefined;
	let used = number(detail?.used);
	if (used === undefined) {
		const remaining = number(detail?.remaining);
		if (remaining === undefined) return undefined;
		used = limit - remaining;
	}
	return (used / limit) * 100;
}

function resetTime(detail: Record<string, unknown> | undefined): number | undefined {
	for (const key of ["resetTime", "reset_time", "resetAt", "reset_at"]) {
		const value = detail?.[key];
		if (typeof value !== "string") continue;
		const time = Date.parse(value);
		if (!Number.isNaN(time)) return time;
	}
	return undefined;
}

/**
 * `{"plan_type","rate_limit":{"primary_window":{used_percent,limit_window_seconds,reset_after_seconds,reset_at},"secondary_window":{…}}}`
 */
function parseCodex(body: unknown, now: number): BalanceReading | undefined {
	const root = record(body);
	const limit = record(root?.rate_limit);
	if (!limit) return undefined;
	const windows: BalanceWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const entry = record(limit[key]);
		const used = number(entry?.used_percent);
		const seconds = number(entry?.limit_window_seconds);
		if (used === undefined || seconds === undefined || seconds <= 0) continue;
		const resetAt = number(entry?.reset_at);
		const resetAfter = number(entry?.reset_after_seconds);
		const resets =
			resetAt !== undefined
				? resetAt * 1000
				: resetAfter !== undefined
					? now + resetAfter * 1000
					: undefined;
		windows.push(window(seconds, used, resets, now));
	}
	if (windows.length === 0) return undefined;
	const plan = typeof root?.plan_type === "string" ? root.plan_type : undefined;
	return { kind: "quota", windows, ...(plan && { plan }) };
}

function window(
	seconds: number,
	used: number,
	resetsAt: number | undefined,
	now: number,
): BalanceWindow {
	return {
		label: windowLabel(seconds),
		usedPercent: Math.min(100, Math.max(0, used)),
		// A reset in the past is stale: the window has rolled over since. One further
		// out than any window lasts is a unit mistake, not a date to show.
		...(resetsAt !== undefined && resetsAt > now && resetsAt - now <= MAX_RESET_MS && { resetsAt }),
	};
}

/** `5h`, `7d`, `30m`: whole units where they fit. */
export function windowLabel(seconds: number): string {
	if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	return `${Math.round(seconds / 60)}m`;
}

function moneyReading(amounts: BalanceAmount[]): BalanceReading | undefined {
	return amounts.length > 0 ? { kind: "money", amounts } : undefined;
}
