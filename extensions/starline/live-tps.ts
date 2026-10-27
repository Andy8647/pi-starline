/**
 * Decode throughput of the latest assistant message, for the `tps` pill.
 *
 * The denominator is the part that is easy to get wrong, so the window is
 * explicit: it opens on the first streamed delta and closes when the message is
 * done. Queueing, time-to-first-token and every tool call in the turn fall
 * outside it, which is what "how fast is this model writing" should mean.
 * `usage.output` is the numerator: it is the one token count the provider reports
 * for the message itself, and it includes thinking tokens.
 *
 * Two halves on purpose. `observe` only sees streaming events, because Pi turns
 * just `text_delta` / `thinking_*` / `toolcall_*` into `message_update` — the
 * stream's `done` event never reaches an extension. The output count therefore
 * has to come from `message_end`, which is what `complete` takes.
 *
 * A provider that hands back a whole message in a single chunk has no stream to
 * measure. Those messages are skipped rather than turned into a fabricated
 * number, and the pill keeps the previous value instead of blinking to blank.
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * Below this the window is noise: two deltas 20 ms apart divide output by
 * almost nothing and report a throughput no model produced. Real streams clear
 * it by an order of magnitude.
 */
const MIN_WINDOW_MS = 100;

/**
 * One delta is a non-streaming reply, not a measurement.
 */
const MIN_DELTAS = 2;

/**
 * The live value needs a longer window than the final one: a single early delta
 * divided by 30 ms reads as thousands of tokens per second, and the pill would
 * flash a nonsense number before settling.
 */
const MIN_LIVE_WINDOW_MS = 400;

/**
 * How often the live value may be replaced. The footer already re-renders on the
 * spinner's tick, so this is not about cost — it is about the number being
 * readable instead of a blur.
 */
const LIVE_UPDATE_MS = 500;

/**
 * Rough token count for streamed text.
 *
 * Pi only reports usage in the final streamed chunk, so a live number cannot use
 * the real count. CJK glyphs cost about a token each and Latin text about four
 * characters per token, which lands within a few tens of percent of the real
 * tokenizer — enough for a moving number that gets corrected at message end.
 */
export function estimateTokens(text: string): number {
	let wide = 0;
	let total = 0;
	for (const character of text) {
		total += 1;
		const code = character.codePointAt(0) ?? 0;
		const isWide =
			(code >= 0x2e80 && code <= 0x9fff) || // CJK
			(code >= 0x3040 && code <= 0x30ff) || // kana
			(code >= 0xac00 && code <= 0xd7af); // hangul
		if (isWide) wide += 1;
	}
	return wide + (total - wide) / 4;
}

export class LiveTpsController {
	private firstDeltaAt: number | undefined;
	private deltas = 0;
	/** Estimated tokens seen so far in the streaming message, for the live value. */
	private streamedTokens = 0;
	private lastLiveAt = 0;
	private latest: number | undefined;

	/** Most recent measured throughput, or undefined before the first one. */
	value(): number | undefined {
		return this.latest;
	}

	/**
	 * End a turn's measurement window without discarding the value. Called when a
	 * new agent run starts: the pill keeps showing the last turn's speed until the
	 * next message finishes.
	 */
	beginTurn(): void {
		this.firstDeltaAt = undefined;
		this.deltas = 0;
		this.streamedTokens = 0;
		this.lastLiveAt = 0;
	}

	/** True while a message is streaming, which is when the value is an estimate. */
	streaming(): boolean {
		return this.firstDeltaAt !== undefined;
	}

	/** Forget everything, value included. A session is over or changed. */
	clear(): void {
		this.beginTurn();
		this.latest = undefined;
	}

	/**
	 * Feed one streaming event. Returns true when the visible number changed, so
	 * the caller can re-render the footer.
	 *
	 * The live value is an estimate over the whole window so far, not a sliding
	 * one: a model that stalls for 800 ms would otherwise show a rate that drops
	 * to nothing even though its average is fine.
	 *
	 * `event` is optional because older Pi builds (and some test harnesses) fire
	 * `message_update` without the `assistantMessageEvent` field.
	 */
	observe(event: AssistantMessageEvent | undefined): boolean {
		if (!event) return false;
		switch (event.type) {
			case "start":
				this.beginTurn();
				return false;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta": {
				const now = Date.now();
				// `firstDeltaAt` is a timestamp, so 0 is a legal value: test not-assigned
				// rather than falsy.
				if (this.firstDeltaAt === undefined) {
					this.firstDeltaAt = now;
					this.lastLiveAt = 0;
				}
				this.deltas += 1;
				this.streamedTokens += estimateTokens(event.delta);
				const windowMs = now - this.firstDeltaAt;
				if (windowMs < MIN_LIVE_WINDOW_MS) return false;
				if (now - this.lastLiveAt < LIVE_UPDATE_MS) return false;
				this.lastLiveAt = now;
				this.latest = this.streamedTokens / (windowMs / 1000);
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * Close the window with the message's own output count. Returns true when the
	 * measurement landed, so the caller can re-render the footer.
	 */
	complete(output: number): boolean {
		const first = this.firstDeltaAt;
		const deltas = this.deltas;
		const windowMs = first === undefined ? 0 : Date.now() - first;
		this.beginTurn();
		if (first === undefined) return false;
		if (deltas < MIN_DELTAS) return false;
		if (!Number.isFinite(output) || output <= 0) return false;
		if (windowMs < MIN_WINDOW_MS) return false;
		this.latest = output / (windowMs / 1000);
		return true;
	}
}
