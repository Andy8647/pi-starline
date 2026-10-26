import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type ColorSpec,
	getExtensionStatusColor,
	getExtensionStatusIcon,
	type PolishedTuiConfig,
} from "./config";
import { setActiveContextSnapshot } from "./context-live";
import { collectExtensionStatusSegments, sanitizeExtensionStatusText } from "./extension-status";
import {
	buildContextDisplayLabel,
	buildSessionDurationLabel,
	contextColorTier,
	formatCwdLabel,
	formatOsLabel,
	formatTimeLabel,
	formatUsernameHostLabel,
} from "./format";
import { renderGitSegments } from "./git-segments";
import { resolveRuntimeSymbol } from "./icons";
import type { LiveContextOverride } from "./live-context";
import { requestPointerShape } from "./mouse/pointer-shape";
import { collectPillInputs, type PillSpan, renderPillBar } from "./pill";
import { pillActionFor, queuedSegmentText, runPillAction } from "./pill-actions";
import { clearPillAnchors, setPillAnchors } from "./pill-anchors";
import { closePillBubble, isPillBubbleOpenFor, type PillAnchor } from "./pill-bubble";
import type { FooterState } from "./state";
import { renderStyleForSource } from "./style";
import { subagentsSegmentText } from "./subagent-fleet";
import { modelPillIcon, readWorkingFrame } from "./working-indicator";

/**
 * Pi's component mouse event and result. Pi dispatches to `handleMouse` from
 * pi-tui 0.85.0; on 0.84.x the method is simply never called.
 */
export type FooterMouseEvent = TuiMouseEvent;

export type FooterMouseResult = TuiMouseEventResult;

/**
 * The footer Pi mounts. `handleMouse` is optional and undeclared by the old
 * component type, which is why the object is built under this local shape.
 */
type FooterComponent = {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
	handleMouse?(event: FooterMouseEvent): FooterMouseResult | undefined;
};

/**
 * How many renders' worth of pill hit maps to keep. A render is also how the
 * layout measures, so one frame can render the footer at more than one width;
 * keying by width keeps a measurement from replacing the map the click on screen
 * will be matched against.
 */
const PILL_HIT_MAP_LIMIT = 4;

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

		/**
		 * Pill hit areas from the render that is on screen, per width.
		 *
		 * Replaced on every render, read only by `handleMouse`: no timers, no
		 * invalidation, nothing to keep in sync with what the footer drew.
		 */
		const pillSpansByWidth = new Map<number, PillSpan[]>();

		const rememberPillSpans = (
			width: number,
			spans: readonly PillSpan[],
			columnOffset: number,
			lineWidth: number,
		) => {
			const visibleSpans: PillSpan[] = [];
			const anchors = new Map<string, PillAnchor>();
			for (const span of spans) {
				// The bar is drawn after a one-column pad, and the line may have been cut
				// again after the bar was; clamp to what the terminal actually shows.
				const startColumn = Math.min(lineWidth, span.startColumn + columnOffset);
				const endColumn = Math.min(lineWidth, span.endColumn + columnOffset);
				if (endColumn <= startColumn) continue;
				const bodyStartColumn = Math.min(endColumn - 1, span.bodyStartColumn + columnOffset);
				const bodyEndColumn = Math.max(
					bodyStartColumn + 1,
					Math.min(endColumn, span.bodyEndColumn + columnOffset),
				);
				visibleSpans.push({ ...span, startColumn, endColumn, bodyStartColumn, bodyEndColumn });
				// Same columns, plus the colours, for anything that wants to sit next to
				// this pill later — a bubble today, whatever the next action needs.
				anchors.set(span.key, {
					key: span.key,
					startColumn: bodyStartColumn,
					endColumn: bodyEndColumn,
					centerColumn: Math.floor((startColumn + endColumn - 1) / 2),
					terminalWidth: width,
					background: span.bg,
					foreground: span.fg,
				});
			}
			pillSpansByWidth.set(width, visibleSpans);
			setPillAnchors(anchors);
			if (pillSpansByWidth.size > PILL_HIT_MAP_LIMIT) {
				const oldest = pillSpansByWidth.keys().next();
				if (!oldest.done) pillSpansByWidth.delete(oldest.value);
			}
		};

		/**
		 * The pill whose action already ran on this mouse-down.
		 *
		 * `click` is not a terminal event: Pi-tui synthesizes one on release for every
		 * press that did not move, and dispatches it to the same component. Running the
		 * action on the press is what takes the button-hold out of the bubble's latency,
		 * so that synthesized click has to be swallowed rather than toggling it back.
		 */
		let pressActed: { key: string; x: number } | null = null;

		const component: FooterComponent = {
			dispose: () => {
				unsubscribeBranch();
				hooks.setRequestRender(undefined);
				hooks.setExtensionStatusesGetter?.(undefined);
			},
			invalidate() {},
			/**
			 * A click on a pill runs that segment's action.
			 *
			 * Pi's footer slot is a `Container`, which forwards mouse events to the
			 * component inside it with `y` rebased to this component and `x` unchanged, so
			 * these are exactly the columns `render` measured. Nothing is declared or
			 * patched for this.
			 *
			 * Returning undefined for anything that is not a target (another row, empty
			 * space, an inert segment) is what lets the click fall through instead of
			 * being swallowed by the footer.
			 */
			handleMouse(event: FooterMouseEvent): FooterMouseResult | undefined {
				if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return undefined;
				// The pill bar is the one and only row this component draws.
				if (event.y !== 0) return undefined;
				const width = typeof event.width === "number" ? Math.floor(event.width) : undefined;
				if (width === undefined) return undefined;
				const spans = pillSpansByWidth.get(width);
				if (!spans) return undefined;

				const hit = spans.find((span) => event.x >= span.startColumn && event.x < span.endColumn);
				const action = hit === undefined ? undefined : pillActionFor(hit.key);
				if (!hit || !action) {
					// Nothing here to click: padding at either end, a gap, or a pill that is
					// only a read-out. For an open bubble this row is then just "outside" like
					// the rest of the screen, and the outside-click dismissal cannot decide
					// that alone — it stays off this row so a press on a pill keeps its
					// toggle. Press, not click: a press that claims nothing is never followed
					// by a synthesized click, and this must not turn into a swallow.
					if (event.type === "press") closePillBubble();
					return undefined;
				}

				// Moving over a pill that does something turns the pointer into a hand.
				// Pi has no leave event; mouse/pointer-shape.ts puts it back once a move
				// lands anywhere that does not ask for it.
				if (event.type === "move") {
					requestPointerShape("pointer");
					return { handled: true };
				}

				const anchor = () => ({
					key: hit.key,
					startColumn: hit.bodyStartColumn,
					endColumn: hit.bodyEndColumn,
					centerColumn: Math.floor((hit.startColumn + hit.endColumn - 1) / 2),
					terminalWidth: width,
					background: hit.bg,
					foreground: hit.fg,
				});

				/**
				 * The action runs on the press, not on Pi's synthesized click.
				 *
				 * Waiting for the click means the bubble opens after the button is released,
				 * which is where the delay came from: a click is press + release + synth, and
				 * that hop is pure added latency for a target one row tall. The press is also
				 * what a drag starts from, so a drag cancels what the press opened.
				 */
				if (event.type === "press") {
					// Pressing the pill again puts its bubble away, like a menu-bar item.
					if (isPillBubbleOpenFor(hit.key)) {
						closePillBubble();
						pressActed = null;
						return { handled: true };
					}
					runPillAction(action, ctx, anchor());
					pressActed = { key: hit.key, x: event.x };
					return { handled: true };
				}

				// A press that moves was a selection or a stray gesture: undo it rather than
				// leaving a bubble the user never asked for. Two columns is past any jitter.
				if (event.type === "drag") {
					if (pressActed && Math.abs(event.x - pressActed.x) > 2) {
						closePillBubble();
						pressActed = null;
					}
					return { handled: true };
				}

				if (event.type === "click") {
					const acted = pressActed;
					pressActed = null;
					// The press already ran this; running it again would toggle the bubble shut.
					if (acted?.key === hit.key) return { handled: true };
					// No press preceded this click, which terminals do not send today, but a
					// synthetic click from elsewhere would still mean what it always meant.
					if (isPillBubbleOpenFor(hit.key)) {
						closePillBubble();
						return { handled: true };
					}
					runPillAction(action, ctx, anchor());
					return { handled: true };
				}

				return { handled: true };
			},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const config = getConfig();
				const colorSource = config.colorSources.starship;
				const iconMode = config.icons.mode;
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
							// While the agent works the spinner takes the icon's slot at the same
							// display width, so the pill never resizes.
							withIcon(
								modelPillIcon(config.icons.model, readWorkingFrame(iconMode === "ascii")),
								state.modelLabel,
							),
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
				const sessionName = sanitizeExtensionStatusText(ctx.sessionManager.getSessionName() ?? "");
				const sessionNameLabel = sessionName
					? renderStyleForSource(theme, colorSource, config.colors.sessionName, sessionName)
					: "";
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
				const costDisplay = withIcon(config.icons.cost, state.costLabel);
				// The one pill shows a percentage; the rest of these numbers are only
				// on screen while its bubble is open.
				const contextTabTokens = useLiveContext ? liveContext.tokens : undefined;
				setActiveContextSnapshot({
					percent: contextPercent ?? undefined,
					contextWindow,
					tokens: contextTabTokens,
					tokenLabel: state.tokenLabel,
					cacheLabel: state.cacheHitLabel,
				});
				const git = renderGitSegments(state, config, theme, colorSource);
				const renderVariable = (name: string): string => {
					switch (name) {
						case "model":
							return modelLabel;
						case "thinking":
							return thinkingLabel;
						case "queue":
							return renderStyleForSource(
								theme,
								colorSource,
								config.colors.queue,
								queuedSegmentText(ctx, config.icons.queue),
							);
						case "subagents":
							return renderStyleForSource(
								theme,
								colorSource,
								config.colors.subagents,
								withIcon(
									config.icons.subagents,
									subagentsSegmentText(config.segmentOptions.subagents.format),
								),
							);
						case "cwd":
							return cwdLabel;
						case "session_name":
							return sessionNameLabel;
						case "git":
							return git.label;
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
						case "cost":
							return renderStyleForSource(theme, colorSource, config.colors.cost, costDisplay);
						case "package_version":
							return state.packageVersion?.version
								? renderStyleForSource(
										theme,
										colorSource,
										config.colors.packageVersion,
										state.packageVersion.version,
									)
								: "";
						case "git_commit":
							return git.commit;
						case "git_tag":
							return git.tag;
						case "git_metrics":
							return git.metrics;
						default:
							return "";
					}
				};
				const extensionStatuses = collectExtensionStatusSegments(
					footerData.getExtensionStatuses(),
					config,
				);

				// Several segment colours are dynamic — the context tier, the detected
				// runtime, the thinking level — so the spec lookup lives here where
				// that state is already resolved, and pill.ts stays presentation-only.
				const pillSpecFor = (segment: string): ColorSpec => {
					switch (segment) {
						case "model":
							return config.colors.model;
						case "thinking":
							return config.colors.thinking ?? thinkingThemeKey(thinkingText);
						case "queue":
							return config.colors.queue;
						case "subagents":
							return config.colors.subagents;
						case "cwd":
							return config.colors.cwd;
						case "sessionName":
							return config.colors.sessionName;
						case "git":
							return config.colors.gitBranch;
						case "gitCommit":
						case "gitTag":
							return config.colors.gitCommit;
						case "gitMetrics":
							return config.colors.gitMetricsAdded;
						case "runtime":
							return state.runtime?.style ?? config.colors.runtimePrefix;
						case "context":
							return contextColor;
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

				const spans: PillSpan[] = [];
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
					{
						ascii: iconMode === "ascii",
						onSpan: (span) => spans.push(span),
					},
				);
				// Nothing has content: draw nothing rather than a bare pair of caps.
				if (!bar) {
					pillSpansByWidth.delete(width);
					clearPillAnchors();
					return [""];
				}
				const columnOffset = width > 2 ? 1 : 0;
				const line = truncateToWidth(width > 2 ? ` ${bar} ` : bar, width, "");
				rememberPillSpans(width, spans, columnOffset, visibleWidth(line));
				return [line];
			},
		};

		return component;
	});
}
