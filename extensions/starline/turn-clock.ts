/**
 * How long the current agent run has been going, and how long the last one took.
 *
 * The pill answers "is it working" with the spinner, but not "for how long" —
 * and that is the question a silent tool asks two minutes in, when the only
 * thing on screen is a frame that has been turning since whenever. The same
 * number is worth keeping once the run ends: what the turn cost in wall time is
 * what you compare the next one against, and a value that vanishes the moment
 * the answer arrives is the one moment it was useful.
 *
 * The clock is set by the two run boundaries Pi already emits, `agent_start` and
 * `agent_end`, and read on every footer render. It is deliberately not a timer:
 * the working spinner drives the TUI's own render loop while a run is going
 * (`Loader` ticks at 80 ms and calls `requestRender`), so a per-second number
 * would only be a second thing to keep in sync. Nothing ticks when idle, and the
 * number is not moving then either.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so the tests can
 * move the wall clock without fake timers.
 */
export class TurnClock {
	private startedAt: number | undefined;
	private lastMs: number | undefined;

	/** A run began: start counting from here, and drop the previous run's total. */
	begin(now: number = Date.now()): void {
		this.startedAt = now;
		// The pill shows one number. While a run is going it is the live one, so
		// keeping the old total around would only be a value nothing draws and every
		// test has to account for.
		this.lastMs = undefined;
	}

	/**
	 * The run ended. The total it reached stays available as `last`, so the pill
	 * keeps reading after the spinner stops.
	 */
	end(now: number = Date.now()): void {
		const elapsed = this.elapsedMs(now);
		if (elapsed !== undefined) this.lastMs = elapsed;
		this.startedAt = undefined;
	}

	/** True while a run is in progress. */
	running(): boolean {
		return this.startedAt !== undefined;
	}

	/**
	 * Milliseconds since the run started, or undefined when no run is going.
	 *
	 * Undefined rather than 0 on purpose: 0 is a legal elapsed time, and the
	 * footer needs to tell "just started" from "not working".
	 */
	elapsedMs(now: number = Date.now()): number | undefined {
		const startedAt = this.startedAt;
		if (startedAt === undefined) return undefined;
		return Math.max(0, now - startedAt);
	}

	/** Both numbers the pill may draw, in one read. */
	timing(now: number = Date.now()): TurnTiming {
		const timing: TurnTiming = {};
		const running = this.elapsedMs(now);
		if (running !== undefined) timing.running = running;
		if (this.lastMs !== undefined) timing.last = this.lastMs;
		return timing;
	}

	/** Forget everything. A session is over or changed, so nothing on screen is ours. */
	clear(): void {
		this.startedAt = undefined;
		this.lastMs = undefined;
	}
}

/** What the pill may draw: the live count while working, and the last total. */
export type TurnTiming = {
	running?: number;
	last?: number;
};
