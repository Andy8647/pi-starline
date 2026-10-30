/**
 * Throughput history: one point per finished message, so the tps bubble can plot
 * speed against how full the context was when it was measured.
 *
 * Two axes, two questions. Throughput alone says how fast the model writes right
 * now; against the context percentage it says whether a filling window is what
 * made it slower. That is the comparison a single number cannot make, and it is
 * why the points are kept instead of only the latest value the pill shows.
 *
 * The history is per session and survives `--continue`: each point is appended
 * as a custom entry, which pi persists but never sends to the model. A reload
 * replays them, so a reopened bubble shows the whole curve rather than whatever
 * happened since the process started.
 */

import { formatCount } from "./format";

export type TpsPoint = {
	/** Tokens per second, as the finished message measured them. */
	tps: number;
	/** Context usage when it was measured, 0-100. */
	percent: number;
	/** Wall-clock time, so a reload can keep the order it was written in. */
	at: number;
};

/** Enough points to fill the graph; older ones fall off the front. */
export const MAX_TPS_POINTS = 60;
/** The custom entry type the history is persisted under. */
export const TPS_ENTRY_TYPE = "starline-tps";

function isTpsPoint(value: unknown): value is TpsPoint {
	if (!value || typeof value !== "object") return false;
	const point = value as Partial<TpsPoint>;
	return (
		typeof point.tps === "number" &&
		Number.isFinite(point.tps) &&
		typeof point.percent === "number" &&
		Number.isFinite(point.percent) &&
		typeof point.at === "number"
	);
}

/**
 * The points of the current session, oldest first.
 *
 * `persist` is injected rather than imported: appending an entry needs the
 * extension API, and this class is easier to test — and to keep out of the
 * footer's render path — without it.
 */
export class TpsHistory {
	private points: TpsPoint[] = [];
	private readonly persist: (point: TpsPoint) => void;

	constructor(persist: (point: TpsPoint) => void = () => {}) {
		this.persist = persist;
	}

	/** Add a measured turn. A point that is not a rate is dropped, not clamped. */
	record(point: TpsPoint): void {
		if (!isTpsPoint(point) || point.tps <= 0) return;
		this.points.push(point);
		if (this.points.length > MAX_TPS_POINTS) {
			this.points.splice(0, this.points.length - MAX_TPS_POINTS);
		}
		this.persist(point);
	}

	/**
	 * Rebuild from the session's entries. Anything that is not a well-formed
	 * point is skipped: a hand-edited or truncated session file must not put a
	 * NaN in the graph.
	 */
	restore(entries: readonly { type?: string; customType?: string; data?: unknown }[]): void {
		const points = entries
			.filter((entry) => entry?.type === "custom" && entry.customType === TPS_ENTRY_TYPE)
			.map((entry) => entry.data)
			.filter(isTpsPoint);
		this.points = points.slice(-MAX_TPS_POINTS);
	}

	all(): readonly TpsPoint[] {
		return this.points;
	}

	clear(): void {
		this.points = [];
	}
}

/** Columns of plot, wide enough to read a trend in a bubble. */
const CHART_WIDTH = 40;
const CHART_HEIGHT = 8;
/** Four columns of y-axis label, then the frame. */
const AXIS_WIDTH = 5;

/** Round the top of the y axis up to a number worth printing. */
function niceCeiling(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 10;
	const step = value <= 10 ? 10 : value <= 100 ? 10 : value <= 500 ? 50 : 100;
	return Math.ceil(value / step) * step;
}

/**
 * The top of the x axis: the fullest window this session has seen, rounded up.
 *
 * A fixed 0-100% puts every point of a young session in the first column or two.
 * The axis grows with the data instead, so the first turns spread across the
 * plot and a window that reaches 80% still shows the curve at a new scale. The
 * small floors keep one point from stretching the axis by itself.
 */
function nicePercentCeiling(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 5;
	const clamped = Math.min(100, value);
	if (clamped <= 5) return 5;
	if (clamped <= 10) return 10;
	if (clamped <= 20) return 20;
	if (clamped <= 25) return 25;
	return Math.min(100, Math.ceil(clamped / 10) * 10);
}

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

/**
 * The x-axis range.
 *
 * A window that barely moved is the common case, not an edge case: a short
 * conversation fills a fraction of a percent per reply, so twenty points land on
 * one column and the plot says nothing. When the session has moved less than ten
 * percent, the axis shows the band it moved through rather than starting at
 * zero, and the labels say where the band is.
 */
function axisRange(percents: readonly number[]): { left: number; right: number } {
	const low = Math.min(...percents);
	const high = Math.max(...percents);
	if (high - low >= 10) return { left: 0, right: nicePercentCeiling(high) };
	if (high === low) {
		// One move, or one point: centre it in a small band.
		return { left: Math.max(0, low - 1), right: Math.min(100, low + 1) };
	}
	return { left: Math.max(0, Math.floor(low)), right: Math.min(100, Math.ceil(high)) };
}

/**
 * A point's cell. Several turns can land on one cell (a stable model, a slowly
 * filling window); counting them keeps that visible instead of hiding all but
 * the last.
 */
const DENSITY = [" ", "·", "+", "#"];

/**
 * The scatter plot: y is tokens per second, x is the context percentage when the
 * reply finished.
 *
 * Both axes are measured off the points: a fixed 0-100% would squash a session
 * that has only reached a fifth of its window into the first column, and a
 * session that stayed in one percent band into the last one.
 *
 * The axes carry the meaning, so they are drawn rather than implied: three y
 * labels (top, middle, zero) and both ends of the x range. A blank region is
 * information too — it means no reply ran at that speed and that fullness yet.
 */
export function tpsChartLines(points: readonly TpsPoint[]): string[] {
	if (points.length === 0) return [];
	const top = niceCeiling(Math.max(...points.map((point) => point.tps)));
	const percents = points.map((point) => clampPercent(point.percent));
	const { left, right } = axisRange(percents);
	const span = Math.max(1, right - left);
	const cells = Array.from({ length: CHART_HEIGHT }, () => new Array<number>(CHART_WIDTH).fill(0));

	for (const [index, point] of points.entries()) {
		const offset = Math.min(span, Math.max(0, percents[index] - left));
		const column = Math.min(CHART_WIDTH - 1, Math.round((offset / span) * (CHART_WIDTH - 1)));
		const row = Math.min(CHART_HEIGHT - 1, Math.floor((point.tps / top) * (CHART_HEIGHT - 1)));
		cells[CHART_HEIGHT - 1 - row][column] += 1;
	}

	const middleRow = Math.floor((CHART_HEIGHT - 1) / 2);
	const labels = new Map<number, string>([
		[0, formatCount(top)],
		[middleRow, formatCount(Math.round(top / 2))],
		[CHART_HEIGHT - 1, "0"],
	]);

	const lines: string[] = cells.map((row, index) => {
		const glyphs = row.map((count) => DENSITY[Math.min(DENSITY.length - 1, count)] ?? "#").join("");
		const label = (labels.get(index) ?? "").padStart(4);
		const frame = index === CHART_HEIGHT - 1 ? "└" : "│";
		return `${label} ${frame}${glyphs}`;
	});

	const pad = " ".repeat(AXIS_WIDTH);
	lines.push(`${pad}└${"─".repeat(CHART_WIDTH)}`);
	const leftLabel = `${left}%`;
	const rightLabel = `${right}%`;
	const gap = Math.max(1, CHART_WIDTH - (leftLabel.length - 2) - rightLabel.length);
	lines.push(`${pad} ${leftLabel}${" ".repeat(gap)}${rightLabel}`);
	return lines;
}

/** The line under the graph: where the latest reply landed, and the average. */
export function tpsSummary(points: readonly TpsPoint[]): string {
	if (points.length === 0) return "No replies measured yet.";
	const last = points[points.length - 1];
	const average = points.reduce((sum, point) => sum + point.tps, 0) / points.length;
	// A point is one assistant message, not one user turn: a turn with tool calls
	// is several messages and several rates.
	const count = points.length === 1 ? "1 msg" : `${points.length} msgs`;
	return `last ${formatCount(Math.round(last.tps))} t/s · avg ${formatCount(
		Math.round(average),
	)} t/s · ${count}`;
}

/** The context percentage a finished message leaves behind, for a point. */
export function contextPercentAfter(
	usage:
		| {
				totalTokens?: number;
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
		  }
		| undefined,
	contextWindow: number | undefined,
): number | undefined {
	if (!usage || !contextWindow || contextWindow <= 0) return undefined;
	const positive = (value: number | undefined) =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
	const total =
		positive(usage.totalTokens) ||
		positive(usage.input) +
			positive(usage.output) +
			positive(usage.cacheRead) +
			positive(usage.cacheWrite);
	if (total <= 0) return undefined;
	return Math.min(100, (total / contextWindow) * 100);
}
