import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelLabelSource, TokensCacheFormat } from "./config";
import {
	buildCacheHitLabel,
	buildContextLabel,
	buildCostLabel,
	buildTokenLabel,
	formatProviderLabel,
	getUsageTotals,
} from "./format";
import type { GitHost, GitStatusSummary } from "./git";
import type { PackageVersionResult } from "./package-version";
import type { RuntimeInfo } from "./runtime";

export type FooterState = GitStatusSummary & {
	modelLabel: string;
	modelId: string;
	modelName: string;
	providerLabel: string;
	contextLabel: string;
	tokenLabel: string;
	cacheHitLabel: string;
	costLabel: string;
	runtime?: RuntimeInfo;
	gitHost?: GitHost;
	packageVersion?: PackageVersionResult;
	sessionStartEpoch?: number;
};

export function createInitialState(gitDefaults: GitStatusSummary): FooterState {
	return {
		modelLabel: "no-model",
		modelId: "",
		modelName: "",
		providerLabel: "Unknown",
		contextLabel: "--",
		tokenLabel: "↑0 ↓0",
		cacheHitLabel: "",
		costLabel: "$0.000",
		runtime: undefined,
		gitHost: undefined,
		packageVersion: undefined,
		sessionStartEpoch: Date.now(),
		...gitDefaults,
	};
}

export function syncState(
	state: FooterState,
	ctx: ExtensionContext,
	cacheHitIcon: string,
	modelLabelSource: ModelLabelSource,
	tokensCache: TokensCacheFormat = "percent",
): void {
	const totals = getUsageTotals(ctx);
	const m = ctx.model;
	state.modelId = m?.id ?? "";
	state.modelName = m?.name ?? "";
	state.modelLabel = (modelLabelSource === "name" ? m?.name || m?.id : m?.id) ?? "no-model";
	state.providerLabel = formatProviderLabel(ctx.model?.provider);
	state.contextLabel = buildContextLabel(ctx);
	state.tokenLabel = buildTokenLabel(totals, cacheHitIcon, tokensCache);
	state.cacheHitLabel = buildCacheHitLabel(totals, cacheHitIcon);
	state.costLabel = buildCostLabel(totals);
}
