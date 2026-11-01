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
import type { PullSnapshot } from "./pull";
import type { RuntimeInfo } from "./runtime";

export type FooterState = GitStatusSummary & {
	modelLabel: string;
	modelId: string;
	modelName: string;
	providerLabel: string;
	contextLabel: string;
	tokenLabel: string;
	/** True once a turn's usage has been recorded, so the session has run something. */
	hasUsage: boolean;
	cacheHitLabel: string;
	costLabel: string;
	runtime?: RuntimeInfo;
	gitHost?: GitHost;
	packageVersion?: PackageVersionResult;
	/** The newest tag, for the mark that says the version above is unreleased. */
	packageTag?: string;
	/** The branch's pull, or the repository's open count, as last read. */
	pull?: PullSnapshot;
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
		hasUsage: false,
		cacheHitLabel: "",
		costLabel: "$0.000",
		runtime: undefined,
		gitHost: undefined,
		packageVersion: undefined,
		pull: undefined,
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
	state.hasUsage = totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0;
	state.cacheHitLabel = buildCacheHitLabel(totals, cacheHitIcon);
	state.costLabel = buildCostLabel(totals);
}
