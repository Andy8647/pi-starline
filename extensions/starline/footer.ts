import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type ColorSpec,
	FOOTER_FORMAT_ALIASES,
	getExtensionStatusColor,
	getExtensionStatusIcon,
	type PolishedTuiConfig,
	type SeparatorStyle,
} from "./config";
import {
	collectExtensionStatusSegments,
	type ExtensionStatusSegment,
	sanitizeExtensionStatusText,
} from "./extension-status";
import { parseFooterFormat, renderFormatSplit, stripOrphanSeparators } from "./footer-format";
import {
	buildContextDisplayLabel,
	buildSessionDurationLabel,
	contextColorTier,
	formatCwdLabel,
	formatGitBranchText,
	formatGitCommitSegment,
	formatGitMetricsSegment,
	formatOsLabel,
	formatPackageVersionSegment,
	formatRuntimeSegment,
	formatTimeLabel,
	formatUsernameHostLabel,
} from "./format";
import type { GitHost } from "./git";
import { type ResolvedIcons, resolveRuntimeSymbol } from "./icons";
import type { LiveContextOverride } from "./live-context";
import { collectPillInputs, renderPillBar } from "./pill";
import type { FooterState } from "./state";
import { renderStyleForSource } from "./style";

const separatorText: Record<SeparatorStyle, string> = {
	pipe: " | ",
	dot: " · ",
	chevron: " › ",
	none: " ",
};

function joinStatusTexts(statusTexts: string[], separator: string): string {
	return statusTexts.filter(Boolean).join(separator);
}

function fitStatusTexts(statusTexts: string[], maxWidth: number, separator: string): string {
	if (maxWidth <= 0) return "";

	const fitted: string[] = [];
	for (const text of statusTexts) {
		const candidate = joinStatusTexts([...fitted, text], separator);
		if (visibleWidth(candidate) <= maxWidth) {
			fitted.push(text);
			continue;
		}

		if (fitted.length === 0) {
			return maxWidth > 1 ? truncateToWidth(text, maxWidth, "…") : "";
		}
		break;
	}

	return joinStatusTexts(fitted, separator);
}

function appendStatusArea(base: string, statusText: string, separator: string): string {
	if (!base) return statusText;
	if (!statusText) return base;
	return `${base}${separator}${statusText}`;
}

function prependStatusArea(base: string, statusText: string, separator: string): string {
	if (!base) return statusText;
	if (!statusText) return base;
	return `${statusText}${separator}${base}`;
}

function composeBuiltInFooterContent(left: string, right: string, innerWidth: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	return leftWidth >= innerWidth
		? truncateToWidth(left, innerWidth, "")
		: leftWidth + 1 + rightWidth <= innerWidth
			? `${left}${" ".repeat(innerWidth - leftWidth - rightWidth)}${right}`
			: truncateToWidth(left, innerWidth, "");
}

function composeFooterContent(
	builtInLeft: string,
	builtInRight: string,
	extensionLeft: string[],
	extensionMiddle: string[],
	extensionRight: string[],
	separator: string,
	innerWidth: number,
): string {
	const builtInLeftWidth = visibleWidth(builtInLeft);
	const builtInRightWidth = visibleWidth(builtInRight);
	const minimumGap = builtInLeft && builtInRight ? 1 : 0;

	if (builtInLeftWidth + minimumGap + builtInRightWidth > innerWidth) {
		return composeBuiltInFooterContent(builtInLeft, builtInRight, innerWidth);
	}

	const available = Math.max(0, innerWidth - builtInLeftWidth - builtInRightWidth - minimumGap);
	let remaining = available;
	const leftConnectorWidth = builtInLeft && extensionLeft.length > 0 ? visibleWidth(separator) : 0;
	const rightConnectorWidth =
		builtInRight && extensionRight.length > 0 ? visibleWidth(separator) : 0;
	let leftStatus = "";
	let rightStatus = "";

	if (extensionLeft.length > 0 && extensionRight.length > 0) {
		const leftBudget = Math.max(0, Math.floor(available / 2) - leftConnectorWidth);
		leftStatus = fitStatusTexts(extensionLeft, leftBudget, separator);
		remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;

		const rightBudget = Math.max(0, remaining - rightConnectorWidth);
		rightStatus = fitStatusTexts(extensionRight, rightBudget, separator);
		remaining -= rightStatus ? rightConnectorWidth + visibleWidth(rightStatus) : 0;

		const expandedLeftBudget = Math.max(0, remaining + visibleWidth(leftStatus));
		const expandedLeftStatus = fitStatusTexts(extensionLeft, expandedLeftBudget, separator);
		if (visibleWidth(expandedLeftStatus) > visibleWidth(leftStatus)) {
			remaining += leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
			leftStatus = expandedLeftStatus;
			remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
		}
	} else if (extensionLeft.length > 0) {
		leftStatus = fitStatusTexts(
			extensionLeft,
			Math.max(0, available - leftConnectorWidth),
			separator,
		);
		remaining -= leftStatus ? leftConnectorWidth + visibleWidth(leftStatus) : 0;
	} else if (extensionRight.length > 0) {
		rightStatus = fitStatusTexts(
			extensionRight,
			Math.max(0, available - rightConnectorWidth),
			separator,
		);
		remaining -= rightStatus ? rightConnectorWidth + visibleWidth(rightStatus) : 0;
	}

	const left = appendStatusArea(builtInLeft, leftStatus, separator);
	const right = prependStatusArea(builtInRight, rightStatus, separator);
	const gapWidth = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(right));
	const middle = fitStatusTexts(extensionMiddle, gapWidth, separator);
	const middleWidth = visibleWidth(middle);

	if (!middle || middleWidth <= 0) {
		return `${left}${" ".repeat(gapWidth)}${right}`;
	}

	const leftPadding = Math.floor((gapWidth - middleWidth) / 2);
	const rightPadding = gapWidth - middleWidth - leftPadding;
	return `${left}${" ".repeat(leftPadding)}${middle}${" ".repeat(rightPadding)}${right}`;
}

/** Forge logo for the branch segment. Empty in ascii mode, which has no glyphs. */
export function gitHostIconGlyph(icons: ResolvedIcons, host: GitHost): string {
	switch (host) {
		case "github":
			return icons.gitHostGithub;
		case "gitlab":
			return icons.gitHostGitlab;
		case "bitbucket":
			return icons.gitHostBitbucket;
		default:
			return icons.gitHostGeneric;
	}
}

/** Prefix a label with an icon, collapsing to the label when there is no icon. */
function withIcon(icon: string, label: string): string {
	if (!label) return "";
	return icon ? `${icon} ${label}` : label;
}

/**
 * Theme colour key for a thinking level. Mirrors the editor metadata line, so
 * the level reads the same whether it sits above the editor or in the footer.
 */
export function thinkingThemeKey(level: string): string {
	switch (level.toLowerCase()) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "thinkingOff";
	}
}

export function installFooter(
	ctx: ExtensionContext,
	state: FooterState,
	getConfig: () => PolishedTuiConfig,
	hooks: {
		setRequestRender: (fn: (() => void) | undefined) => void;
		scheduleProjectRefresh: (ctx: ExtensionContext) => void;
		setExtensionStatusesGetter?: (fn: (() => ReadonlyMap<string, string>) | undefined) => void;
		getLiveContext?: () => LiveContextOverride | undefined;
		getThinkingLevel?: () => string | undefined;
	},
): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		hooks.setExtensionStatusesGetter?.(() => footerData.getExtensionStatuses());
		const unsubscribeBranch = footerData.onBranchChange(() => {
			hooks.scheduleProjectRefresh(ctx);
			tui.requestRender();
		});

		return {
			dispose: () => {
				unsubscribeBranch();
				hooks.setRequestRender(undefined);
				hooks.setExtensionStatusesGetter?.(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const config = getConfig();
				const colorSource = config.colorSources.starship;
				const iconMode = config.icons.mode;
				const separator = renderStyleForSource(
					theme,
					colorSource,
					config.colors.separator,
					separatorText[config.separator],
				);
				const innerWidth = Math.max(1, width - 2);
				const cwdLabel = renderStyleForSource(
					theme,
					colorSource,
					config.colors.cwd,
					formatCwdLabel(ctx.cwd, config.icons.cwd, {
						mode: config.pathDisplay.mode,
						depth: config.pathDisplay.depth,
					}),
				);
				const modelLabel = state.modelLabel
					? renderStyleForSource(
							theme,
							colorSource,
							config.colors.model,
							withIcon(config.icons.model, state.modelLabel),
						)
					: "";
				// "off" reads as no thinking at all, matching the editor metadata line.
				const thinkingLevel = hooks.getThinkingLevel?.() ?? "";
				const thinkingText = thinkingLevel.toLowerCase() === "off" ? "" : thinkingLevel;
				const thinkingLabel = thinkingText
					? renderStyleForSource(
							theme,
							colorSource,
							config.colors.thinking ?? thinkingThemeKey(thinkingText),
							withIcon(config.icons.thinking, thinkingText),
						)
					: "";
				const needsSessionName = config.footerFormat
					? /(?:\$session_name\b|\$\{session_name\})/.test(config.footerFormat)
					: config.footerSegments.sessionName;
				const sessionName = needsSessionName
					? sanitizeExtensionStatusText(ctx.sessionManager.getSessionName() ?? "")
					: "";
				const sessionNameLabel = sessionName
					? renderStyleForSource(theme, colorSource, config.colors.sessionName, sessionName)
					: "";
				const builtInSessionNameLabel = sessionNameLabel ? `in ${sessionNameLabel}` : "";
				const branch = state.branch;
				const branchText = branch
					? formatGitBranchText(branch, config.gitBranch.maxLength)
					: undefined;
				const contextUsage = ctx.getContextUsage();
				const liveContext = hooks.getLiveContext?.();
				const contextWindow = ctx.model?.contextWindow ?? contextUsage?.contextWindow;
				const useLiveContext =
					liveContext !== undefined && contextWindow !== undefined && contextWindow > 0;
				const contextPercent = useLiveContext
					? (liveContext.tokens / contextWindow) * 100
					: contextUsage?.percent;
				const contextLabel = buildContextDisplayLabel({
					percent: contextPercent,
					contextWindow,
					style: config.contextStyle,
					asciiGauge: iconMode === "ascii",
					format: config.segmentOptions.context.format,
				});
				const tier = contextColorTier(contextPercent, config.contextThresholds);
				const contextColor =
					tier === "error"
						? config.colors.contextError
						: tier === "warning"
							? config.colors.contextWarning
							: config.colors.contextNormal;
				const contextDisplay = withIcon(config.icons.context, contextLabel);
				const tokensDisplay = withIcon(config.icons.tokens, state.tokenLabel);
				const costDisplay = withIcon(config.icons.cost, state.costLabel);
				// The cacheHit icon doubles as the tokens segment's inline cache glyph;
				// state.cacheHitLabel already carries it, so no withIcon here.
				const cacheHitDisplay = state.cacheHitLabel;
				const gitColor = (text: string) =>
					renderStyleForSource(theme, colorSource, config.colors.gitBranch, text);
				const gitStatusColor = (text: string) =>
					renderStyleForSource(theme, colorSource, config.colors.gitStatus, text);
				// With gitHostIcon on, the branch icon becomes the origin remote's forge
				// logo. Repos with no origin, and ascii mode (whose host glyphs are all
				// empty), fall back to the plain branch icon.
				const gitHostGlyph =
					config.gitHostIcon && state.gitHost ? gitHostIconGlyph(config.icons, state.gitHost) : "";
				const gitGlyph = gitHostGlyph || config.icons.git;
				const gitIcon = gitGlyph ? gitColor(gitGlyph) : "";
				const gitCounts = config.footerSegments.gitCounts;
				const stashLabel =
					state.stashed > 0
						? gitCounts
							? `${config.icons.stashed}${state.stashed}`
							: config.icons.stashed
						: "";
				const allStatus = [
					state.conflicted > 0 ? config.icons.conflicted : "",
					stashLabel,
					state.deleted > 0 ? config.icons.deleted : "",
					state.renamed > 0 ? config.icons.renamed : "",
					state.modified > 0 ? config.icons.modified : "",
					state.typechanged > 0 ? config.icons.typechanged : "",
					state.staged > 0 ? config.icons.staged : "",
					state.untracked > 0 ? config.icons.untracked : "",
				].join("");
				const aheadBehind = (() => {
					if (state.ahead > 0 && state.behind > 0) {
						return gitCounts
							? `${config.icons.ahead}${state.ahead}${config.icons.behind}${state.behind}`
							: config.icons.diverged;
					}
					if (state.ahead > 0)
						return gitCounts ? `${config.icons.ahead}${state.ahead}` : config.icons.ahead;
					if (state.behind > 0)
						return gitCounts ? `${config.icons.behind}${state.behind}` : config.icons.behind;
					return "";
				})();
				const statusBlock =
					allStatus || aheadBehind ? gitStatusColor(`[${allStatus}${aheadBehind}]`) : "";
				const gitStateLabel = state.gitStateLabel ?? "";
				const gitStateBlock = gitStateLabel ? gitStatusColor(gitStateLabel) : "";
				const renderVariable = (name: string): string => {
					const canonical = FOOTER_FORMAT_ALIASES[name] ?? name;
					switch (canonical) {
						case "model":
							return modelLabel;
						case "thinking":
							return thinkingLabel;
						case "cwd":
							return cwdLabel;
						case "session_name":
							return sessionNameLabel;
						case "git_branch":
							return branchText
								? gitIcon
									? `${gitIcon} ${gitColor(branchText)}`
									: gitColor(branchText)
								: "";
						case "git_status":
							return statusBlock;
						case "git_state":
							return gitStateBlock;
						case "runtime": {
							if (!state.runtime) return "";
							const symbol = resolveRuntimeSymbol(
								state.runtime.name,
								state.runtime.symbol,
								iconMode,
							);
							const label = state.runtime.version ? `${symbol} ${state.runtime.version}` : symbol;
							return renderStyleForSource(theme, colorSource, state.runtime.style, label);
						}
						case "session_duration":
							return state.sessionStartEpoch
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.sessionDuration,
										buildSessionDurationLabel(state.sessionStartEpoch),
									)
								: "";
						case "username":
							return renderStyleForSource(
								theme,
								colorSource,
								config.colors.username,
								formatUsernameHostLabel(config.icons.username),
							);
						case "os":
							return renderStyleForSource(
								theme,
								colorSource,
								config.colors.os,
								formatOsLabel(config.icons.os, iconMode),
							);
						case "time":
							return renderStyleForSource(
								theme,
								colorSource,
								config.colors.time,
								formatTimeLabel(config.icons.time),
							);
						case "context":
							return renderStyleForSource(theme, colorSource, contextColor, contextDisplay);
						case "tokens":
							return renderStyleForSource(theme, colorSource, config.colors.tokens, tokensDisplay);
						case "cache_hit":
							return cacheHitDisplay
								? renderStyleForSource(theme, colorSource, config.colors.cacheHit, cacheHitDisplay)
								: "";
						case "cost":
							return renderStyleForSource(theme, colorSource, config.colors.cost, costDisplay);
						case "package":
							return formatPackageVersionSegment(
								theme,
								state.packageVersion,
								colorSource,
								iconMode,
								config.icons.package,
								config.colors.packageVersion,
							);
						case "package_version":
							return state.packageVersion?.version
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.packageVersion,
										state.packageVersion.version,
									)
								: "";
						case "sep":
							return renderStyleForSource(theme, colorSource, config.colors.separator, " | ");
						case "git_commit":
							return formatGitCommitSegment(
								theme,
								state.commit,
								config.gitCommit,
								colorSource,
								config.colors.gitCommit,
							);
						case "git_tag":
							return config.gitCommit.showTag && state.commit?.tag
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.gitCommit,
										state.commit.tag,
									)
								: "";
						case "git_metrics":
							return formatGitMetricsSegment(
								theme,
								state.metrics,
								config.gitMetrics,
								colorSource,
								config.colors.gitMetricsAdded,
								config.colors.gitMetricsDeleted,
							);
						case "git_added":
							return state.metrics
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.gitMetricsAdded,
										`+${state.metrics.added}`,
									)
								: "";
						case "git_deleted":
							return state.metrics
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.gitMetricsDeleted,
										`−${state.metrics.deleted}`,
									)
								: "";
						default:
							return "";
					}
				};
				const branchParts: string[] = [];
				if (config.footerSegments.gitBranch) {
					if (branchText) {
						branchParts.push("on", gitIcon, gitColor(branchText));
					} else if (state.commit?.detached) {
						// `HEAD` uses git-branch style; `(hash)` uses git-commit style
						// (bold green) per Starship `git_commit` format.
						branchParts.push("on", gitIcon, gitColor("HEAD"));
						if (config.footerSegments.gitCommit && state.commit.oid) {
							const shortHash = state.commit.oid.slice(0, config.gitCommit.hashLength);
							const tag = config.gitCommit.showTag && state.commit.tag ? state.commit.tag : "";
							const inner = [shortHash, tag].filter(Boolean).join(" ");
							branchParts.push(
								renderStyleForSource(theme, colorSource, config.colors.gitCommit, `(${inner})`),
							);
						}
					}
				}
				const gitStatusParts = config.footerSegments.gitStatus && statusBlock ? [statusBlock] : [];
				const showGitState = config.footerSegments.gitBranch || config.footerSegments.gitStatus;
				const gitStateParts = showGitState && gitStateBlock ? [gitStateBlock] : [];
				const branchLabel = [...branchParts, ...gitStatusParts, ...gitStateParts]
					.filter(Boolean)
					.join(" ");
				const runtimeLabel = config.footerSegments.runtime
					? formatRuntimeSegment(
							theme,
							state.runtime,
							config.colors.runtimePrefix,
							colorSource,
							iconMode,
						)
					: "";
				const packageVersionLabel = config.footerSegments.packageVersion
					? formatPackageVersionSegment(
							theme,
							state.packageVersion,
							colorSource,
							iconMode,
							config.icons.package,
							config.colors.packageVersion,
						)
					: "";
				// Skip standalone gitCommit when hash is already folded into the
				// branch display on detached HEAD.
				const hashFoldedIntoBranch = state.commit?.detached && config.footerSegments.gitBranch;
				const gitCommitLabel =
					config.footerSegments.gitCommit && !hashFoldedIntoBranch
						? formatGitCommitSegment(
								theme,
								state.commit,
								config.gitCommit,
								colorSource,
								config.colors.gitCommit,
							)
						: "";
				const gitMetricsLabel = config.footerSegments.gitMetrics
					? formatGitMetricsSegment(
							theme,
							state.metrics,
							config.gitMetrics,
							colorSource,
							config.colors.gitMetricsAdded,
							config.colors.gitMetricsDeleted,
						)
					: "";

				const sessionDurationSegment = (() => {
					if (!config.footerSegments.sessionDuration || !state.sessionStartEpoch) return "";
					const timeLabel = buildSessionDurationLabel(state.sessionStartEpoch);
					const prefix = renderStyleForSource(theme, colorSource, "", "up for");
					const time = renderStyleForSource(
						theme,
						colorSource,
						config.colors.sessionDuration,
						timeLabel,
					);
					return `${prefix} ${time}`;
				})();
				const usernameSegment = config.footerSegments.username
					? renderStyleForSource(
							theme,
							colorSource,
							config.colors.username,
							formatUsernameHostLabel(config.icons.username),
						)
					: "";
				const osSegment = config.footerSegments.os
					? renderStyleForSource(
							theme,
							colorSource,
							config.colors.os,
							formatOsLabel(config.icons.os, iconMode),
						)
					: "";
				const left = [
					config.footerSegments.model ? modelLabel : "",
					config.footerSegments.thinking ? thinkingLabel : "",
					osSegment,
					usernameSegment,
					config.footerSegments.cwd ? cwdLabel : "",
					config.footerSegments.sessionName ? builtInSessionNameLabel : "",
					branchLabel,
					gitCommitLabel,
					gitMetricsLabel,
					packageVersionLabel,
					runtimeLabel,
					sessionDurationSegment,
				]
					.filter(Boolean)
					.join(" ");

				const timeSegment = config.footerSegments.time
					? renderStyleForSource(
							theme,
							colorSource,
							config.colors.time,
							formatTimeLabel(config.icons.time),
						)
					: "";
				const right = [
					config.footerSegments.context
						? renderStyleForSource(theme, colorSource, contextColor, contextDisplay)
						: "",
					config.footerSegments.tokens
						? renderStyleForSource(theme, colorSource, config.colors.tokens, tokensDisplay)
						: "",
					config.footerSegments.cacheHit && cacheHitDisplay
						? renderStyleForSource(theme, colorSource, config.colors.cacheHit, cacheHitDisplay)
						: "",
					config.footerSegments.cost
						? renderStyleForSource(theme, colorSource, config.colors.cost, costDisplay)
						: "",
					timeSegment,
				]
					.filter(Boolean)
					.join(separator);

				let contentLeft = left;
				let contentMiddle = "";
				let contentRight = right;
				if (config.footerFormat) {
					const {
						left: fmtLeft,
						middle: fmtMiddle,
						right: fmtRight,
					} = renderFormatSplit(parseFooterFormat(config.footerFormat), renderVariable);
					contentLeft = stripOrphanSeparators(fmtLeft);
					contentMiddle = stripOrphanSeparators(fmtMiddle);
					contentRight = stripOrphanSeparators(fmtRight);
				}

				const extensionStatuses = collectExtensionStatusSegments(
					footerData.getExtensionStatuses(),
					config,
				);

				if (config.footerStyle === "pill") {
					// Several segment colours are dynamic — the context tier, the detected
					// runtime, the thinking level — so the spec lookup lives here where
					// that state is already resolved, and pill.ts stays presentation-only.
					const pillSpecFor = (segment: string): ColorSpec => {
						switch (segment) {
							case "model":
								return config.colors.model;
							case "thinking":
								return config.colors.thinking ?? thinkingThemeKey(thinkingText);
							case "cwd":
								return config.colors.cwd;
							case "sessionName":
								return config.colors.sessionName;
							case "gitBranch":
								return config.colors.gitBranch;
							case "gitStatus":
							case "gitState":
								return config.colors.gitStatus;
							case "gitCommit":
							case "gitTag":
								return config.colors.gitCommit;
							case "gitMetrics":
								return config.colors.gitMetricsAdded;
							case "runtime":
								return state.runtime?.style ?? config.colors.runtimePrefix;
							case "context":
								return contextColor;
							case "tokens":
								return config.colors.tokens;
							case "cacheHit":
								return config.colors.cacheHit;
							case "cost":
								return config.colors.cost;
							case "sessionDuration":
								return config.colors.sessionDuration;
							case "username":
								return config.colors.username;
							case "time":
								return config.colors.time;
							case "os":
								return config.colors.os;
							case "packageVersion":
								return config.colors.packageVersion;
							default:
								return config.colors.extensionStatus;
						}
					};

					const bar = renderPillBar(
						collectPillInputs(
							config.pill.segments,
							[...extensionStatuses.left, ...extensionStatuses.middle, ...extensionStatuses.right],
							renderVariable,
							pillSpecFor,
							(key) => getExtensionStatusColor(config, key) ?? config.colors.extensionStatus,
							(key) => getExtensionStatusIcon(config, key),
						),
						theme,
						colorSource,
						config.pill,
						Math.max(0, width - 2),
						{ ascii: iconMode === "ascii" },
					);
					// An empty bar means nothing had content; fall through to the text
					// footer rather than emit a bare pair of caps.
					if (bar) return [truncateToWidth(width > 2 ? ` ${bar} ` : bar, width, "")];
				}

				const renderExtensionStatus = (segment: ExtensionStatusSegment) =>
					segment.colorMode === "original"
						? segment.text
						: renderStyleForSource(theme, colorSource, config.colors.extensionStatus, segment.text);
				const extensionMiddleSegments = extensionStatuses.middle.map(renderExtensionStatus);
				const middleSegments = contentMiddle
					? [contentMiddle, ...extensionMiddleSegments]
					: extensionMiddleSegments;
				const content = composeFooterContent(
					contentLeft,
					contentRight,
					extensionStatuses.left.map(renderExtensionStatus),
					middleSegments,
					extensionStatuses.right.map(renderExtensionStatus),
					separator,
					innerWidth,
				);
				const framed = width > 2 ? ` ${truncateToWidth(content, width - 2, "")} ` : content;
				return [truncateToWidth(framed, width, "")];
			},
		};
	});
}
