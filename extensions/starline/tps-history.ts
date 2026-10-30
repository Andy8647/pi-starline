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

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, percent));
}

/**
 * A point's cell. Several turns can land on one cell (a stable model, a slowly
 * filling window); counting them keeps that visible instead of hiding all but
 * the last.
 */
const DENSITY = [" ", "·", "+", "#"];

/**
 * The scatter plot: y is tokens per second, x is the context percentage when the
 * turn finished.
 *
 * The axes carry the meaning, so they are drawn rather than implied: three y
 * labels (top, middle, zero) and both ends of the x range. A blank region is
 * information too — it means no turn ran at that speed and that fullness yet.
 */
export function tpsChartLines(points: readonly TpsPoint[]): string[] {
	if (points.length === 0) return [];
	const top = niceCeiling(Math.max(...points.map((point) => point.tps)));
	const cells = Array.from({ length: CHART_HEIGHT }, () => new Array<number>(CHART_WIDTH).fill(0));

	for (const point of points) {
		const column = Math.min(
			CHART_WIDTH - 1,
			Math.round((clampPercent(point.percent) / 100) * (CHART_WIDTH - 1)),
		);
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
	const right = "100%";
	lines.push(`${pad} 0%${" ".repeat(Math.max(1, CHART_WIDTH - 2 - right.length))}${right}`);
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
