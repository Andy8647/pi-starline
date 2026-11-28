import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BalanceReading,
	balanceSourceFor,
	codexAccountId,
	fetchBalance,
	parseBalance,
	readCodexHeaders,
	windowLabel,
} from "../extensions/starline/balance";
import {
	balanceBubbleLines,
	balancePillText,
	observeBalanceHeaders,
	refreshBalance,
	resetBalance,
	setBalanceHost,
} from "../extensions/starline/balance-pill";

const NOW = Date.parse("2026-11-28T12:00:00Z");

/** A JWT-shaped token whose payload carries the ChatGPT account, like Codex's. */
function codexToken(account = "acct-123"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function source(baseUrl: string) {
	const found = balanceSourceFor(baseUrl);
	if (!found) throw new Error(`no source for ${baseUrl}`);
	return found;
}

// The shape DeepSeek returned on 2026-11-28, with the numbers changed.
const DEEPSEEK = {
	is_available: true,
	balance_infos: [
		{ currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
		{
			currency: "CNY",
			total_balance: "1059.84",
			granted_balance: "797.56",
			topped_up_balance: "262.28",
		},
	],
};

// Moonshot's documented `/v1/users/me/balance`.
const MOONSHOT = {
	code: 0,
	data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
	scode: "0x0",
	status: true,
};

// OpenRouter's documented `/api/v1/credits`.
const OPENROUTER = { data: { total_credits: 20, total_usage: 7.25 } };

// The shape kimi-cli's `/usage` reads: numbers arrive as strings too.
const KIMI = {
	usage: { limit: "1000", remaining: "600", resetTime: "2026-12-01T00:00:00Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", used: "25", resetTime: "2026-11-28T14:30:00Z" },
		},
	],
};

// Codex's `/wham/usage`, per codex-rs `RateLimitStatusPayload`.
const CODEX = {
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: {
			used_percent: 28,
			limit_window_seconds: 18_000,
			reset_after_seconds: 7_200,
			reset_at: NOW / 1000 + 7_200,
		},
		secondary_window: {
			used_percent: 60,
			limit_window_seconds: 604_800,
			reset_after_seconds: 259_200,
			reset_at: NOW / 1000 + 259_200,
		},
	},
};

describe("balanceSourceFor", () => {
	it("recognises each provider by the host the model already talks to", () => {
		expect(source("https://api.deepseek.com").url).toBe("https://api.deepseek.com/user/balance");
		expect(source("https://api.moonshot.cn/v1")).toMatchObject({
			url: "https://api.moonshot.cn/v1/users/me/balance",
			currency: "CNY",
		});
		expect(source("https://api.moonshot.ai/v1").currency).toBe("USD");
		expect(source("https://openrouter.ai/api/v1").url).toBe("https://openrouter.ai/api/v1/credits");
		expect(source("https://us.openrouter.ai/api/v1").url).toBe(
			"https://us.openrouter.ai/api/v1/credits",
		);
		expect(source("https://api.kimi.com/coding/v1").url).toBe(
			"https://api.kimi.com/coding/v1/usages",
		);
		expect(source("https://chatgpt.com/backend-api").url).toBe(
			"https://chatgpt.com/backend-api/wham/usage",
		);
	});

	it("recognises nothing else, a proxy in front of a provider included", () => {
		for (const url of [
			"https://my-proxy.example.com/deepseek",
			"https://api.openai.com/v1",
			"http://api.deepseek.com",
			"https://api.kimi.com/v1",
			"not a url",
			undefined,
		]) {
			expect(balanceSourceFor(url)).toBeUndefined();
		}
	});
});

describe("parseBalance", () => {
	it("reads every DeepSeek currency with what it is made of", () => {
		expect(parseBalance(source("https://api.deepseek.com"), DEEPSEEK, NOW)).toEqual({
			kind: "money",
			amounts: [
				{
					currency: "USD",
					total: 0,
					parts: [
						{ label: "granted", amount: 0 },
						{ label: "topped up", amount: 0 },
					],
				},
				{
					currency: "CNY",
					total: 1059.84,
					parts: [
						{ label: "granted", amount: 797.56 },
						{ label: "topped up", amount: 262.28 },
					],
				},
			],
		});
	});

	it("reads Moonshot in the currency of the host it bills from", () => {
		const reading = parseBalance(source("https://api.moonshot.cn/v1"), MOONSHOT, NOW);
		expect(reading).toMatchObject({
			kind: "money",
			amounts: [{ currency: "CNY", total: 49.58894 }],
		});
	});

	it("reads OpenRouter as credits bought minus credits used", () => {
		const reading = parseBalance(source("https://openrouter.ai/api/v1"), OPENROUTER, NOW);
		expect(reading).toMatchObject({ kind: "money", amounts: [{ currency: "USD", total: 12.75 }] });
	});

	it("reads the Kimi coding plan's windows, short ones first, from used or remaining", () => {
		expect(parseBalance(source("https://api.kimi.com/coding/v1"), KIMI, NOW)).toEqual({
			kind: "quota",
			windows: [
				{ label: "5h", usedPercent: 25, resetsAt: Date.parse("2026-11-28T14:30:00Z") },
				{ label: "7d", usedPercent: 40, resetsAt: Date.parse("2026-12-01T00:00:00Z") },
			],
		});
	});

	it("reads Codex's two windows and the plan", () => {
		expect(parseBalance(source("https://chatgpt.com/backend-api"), CODEX, NOW)).toEqual({
			kind: "quota",
			plan: "plus",
			windows: [
				{ label: "5h", usedPercent: 28, resetsAt: NOW + 7_200_000 },
				{ label: "7d", usedPercent: 60, resetsAt: NOW + 259_200_000 },
			],
		});
	});

	it("drops a reset time that has already passed", () => {
		const stale = structuredClone(CODEX);
		stale.rate_limit.primary_window.reset_at = NOW / 1000 - 60;
		const reading = parseBalance(source("https://chatgpt.com/backend-api"), stale, NOW);
		expect(reading?.kind === "quota" && reading.windows[0]?.resetsAt).toBeUndefined();
	});

	it("recognises nothing in an answer of another shape", () => {
		const cases: Array<[string, unknown]> = [
			["https://api.deepseek.com", { balance_infos: [{ currency: "CNY" }] }],
			["https://api.deepseek.com", { error: "unauthorized" }],
			["https://api.moonshot.cn/v1", { code: 0, data: {} }],
			["https://openrouter.ai/api/v1", { data: { total_credits: "lots" } }],
			["https://api.kimi.com/coding/v1", { limits: [{ detail: { limit: 0, used: 1 } }] }],
			["https://chatgpt.com/backend-api", { rate_limit: { primary_window: {} } }],
			["https://chatgpt.com/backend-api", null],
		];
		for (const [url, body] of cases) {
			expect(parseBalance(source(url), body, NOW)).toBeUndefined();
		}
	});
});

describe("fetchBalance", () => {
	it("sends the key to the provider's endpoint and parses the answer", async () => {
		const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => DEEPSEEK }));
		const reading = await fetchBalance(source("https://api.deepseek.com"), "sk-test", {
			fetch,
			now: NOW,
		});
		expect(reading?.kind).toBe("money");
		expect(fetch).toHaveBeenCalledWith(
			"https://api.deepseek.com/user/balance",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
			}),
		);
	});

	it("adds the ChatGPT account Codex's token belongs to", async () => {
		const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => CODEX }));
		await fetchBalance(source("https://chatgpt.com/backend-api"), codexToken("acct-9"), {
			fetch,
			now: NOW,
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/wham/usage",
			expect.objectContaining({
				headers: expect.objectContaining({ "chatgpt-account-id": "acct-9" }),
			}),
		);
	});

	it("does not ask Codex without an account to ask about", async () => {
		const fetch = vi.fn();
		const reading = await fetchBalance(source("https://chatgpt.com/backend-api"), "not-a-jwt", {
			fetch,
		});
		expect(reading).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("resolves nothing for a refused request or a network failure", async () => {
		const refused = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
		const broken = vi.fn(async () => {
			throw new Error("offline");
		});
		expect(
			await fetchBalance(source("https://api.deepseek.com"), "k", { fetch: refused }),
		).toBeUndefined();
		expect(
			await fetchBalance(source("https://api.deepseek.com"), "k", { fetch: broken }),
		).toBeUndefined();
	});
});

describe("Codex headers", () => {
	it("reads the windows Codex sends with every HTTP response", () => {
		const reading = readCodexHeaders(
			{
				"X-Codex-Primary-Used-Percent": "12.5",
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(NOW / 1000 + 600),
				"x-codex-secondary-used-percent": "40",
				"x-codex-secondary-window-minutes": "10080",
			},
			NOW,
		);
		expect(reading).toEqual({
			kind: "quota",
			windows: [
				{ label: "5h", usedPercent: 12.5, resetsAt: NOW + 600_000 },
				{ label: "7d", usedPercent: 40 },
			],
		});
	});

	it("reads nothing from a response without them", () => {
		expect(readCodexHeaders({ "content-type": "text/event-stream" }, NOW)).toBeUndefined();
	});

	it("takes the account from the token's auth claim", () => {
		expect(codexAccountId(codexToken("acct-1"))).toBe("acct-1");
		expect(codexAccountId("a.b.c")).toBeUndefined();
	});

	it("names windows in whole units", () => {
		expect([windowLabel(18_000), windowLabel(604_800), windowLabel(1_800)]).toEqual([
			"5h",
			"7d",
			"30m",
		]);
	});
});

describe("balancePillText", () => {
	it("shows the first currency that has money in it", () => {
		const reading = parseBalance(source("https://api.deepseek.com"), DEEPSEEK, NOW);
		expect(balancePillText(reading, "$")).toBe("$ ¥1,059.84");
	});

	it("shows what is left of each window", () => {
		const reading = parseBalance(source("https://chatgpt.com/backend-api"), CODEX, NOW);
		expect(balancePillText(reading, "")).toBe("5h 72% · 7d 40%");
	});

	it("is empty with nothing read", () => {
		expect(balancePillText(undefined, "$")).toBe("");
	});
});

describe("balanceBubbleLines", () => {
	const money = (total: number): BalanceReading => ({
		kind: "money",
		amounts: [{ currency: "CNY", total, parts: [{ label: "granted", amount: 1 }] }],
	});

	it("lists each currency with its parts and what changed since the last check", () => {
		const lines = balanceBubbleLines(
			{ reading: money(100), at: NOW },
			{ reading: money(102.5), at: NOW - 5 * 60_000 },
			NOW,
		);
		expect(lines).toEqual(["CNY  ¥100.00  ▼ ¥2.50 since 5m ago", "     granted ¥1.00"]);
	});

	it("says nothing about a change when there was none", () => {
		const lines = balanceBubbleLines(
			{ reading: money(100), at: NOW },
			{ reading: money(100), at: NOW },
			NOW,
		);
		expect(lines[0]).toBe("CNY  ¥100.00");
	});

	it("draws each window with what is left and when it resets", () => {
		const reading = parseBalance(source("https://chatgpt.com/backend-api"), CODEX, NOW);
		if (!reading) throw new Error("expected a reading");
		expect(balanceBubbleLines({ reading, at: NOW }, undefined, NOW)).toEqual([
			"5h  ███████░░░  72% left · resets in 2h",
			"7d  ████░░░░░░  40% left · resets in 3d",
		]);
	});
});

describe("refreshBalance", () => {
	let enabled = true;
	let renders = 0;
	const fetchMock = vi.fn();

	function ctxFor(baseUrl: string, apiKey = "sk-test"): ExtensionContext {
		return {
			model: { provider: "p", id: "m", baseUrl },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey }) },
		} as unknown as ExtensionContext;
	}

	beforeEach(() => {
		enabled = true;
		renders = 0;
		resetBalance();
		setBalanceHost({ isEnabled: () => enabled, requestRender: () => (renders += 1) });
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => ({
			ok: true,
			status: 200,
			json: async () => DEEPSEEK,
		}));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		setBalanceHost(undefined);
	});

	it("asks nothing while the pill is not in the bar", async () => {
		enabled = false;
		await refreshBalance(ctxFor("https://api.deepseek.com"));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks nothing for a provider it does not know", async () => {
		await refreshBalance(ctxFor("https://api.openai.com/v1"));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks once a minute for the same account, unless forced", async () => {
		const ctx = ctxFor("https://api.deepseek.com");
		await refreshBalance(ctx);
		await refreshBalance(ctx);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await refreshBalance(ctx, true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(renders).toBeGreaterThan(0);
	});

	it("asks at once when the model moves to another account", async () => {
		await refreshBalance(ctxFor("https://api.deepseek.com"));
		await refreshBalance(ctxFor("https://openrouter.ai/api/v1"));
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"https://api.deepseek.com/user/balance",
			"https://openrouter.ai/api/v1/credits",
		]);
	});

	it("takes Codex's windows from response headers only while the model is on Codex", async () => {
		const headers = {
			"x-codex-primary-used-percent": "10",
			"x-codex-primary-window-minutes": "300",
		};
		observeBalanceHeaders(headers);
		expect(renders).toBe(0);
		fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => CODEX }));
		await refreshBalance(ctxFor("https://chatgpt.com/backend-api", codexToken()));
		const before = renders;
		observeBalanceHeaders(headers);
		expect(renders).toBe(before + 1);
	});
});
