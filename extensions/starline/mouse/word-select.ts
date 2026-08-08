/**
 * Which columns a double click on one line should select.
 *
 * Ported from `getWordSelection` in pi commit `56419be51`
 * (`feat/word-selection-path-chars`, `packages/tui/src/tui-alt-screen.ts`),
 * filed upstream as issue #7746. The installed Pi build's own
 * `getWordSelection` predates that patch, so this substitutes Pi's whole
 * word-selection rule rather than layering path handling on top of it — see
 * `index.ts` for where that substitution happens and why it's the intended
 * scope, not creep.
 *
 * This is a pure function of one already-plain (no ANSI) line and a terminal
 * column; the caller in `index.ts` is what reads Pi's live source line and
 * strips escape sequences before calling in, matching the split
 * `getWordSelection`/`getSelectionSourceLine` already have upstream.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Characters that join two words into one for double-click selection.
 *
 * `Intl.Segmenter` already keeps `_` and `.` inside a word, so `foo_bar` and
 * `file.ts` survive on their own. It breaks on `/` and `-`, which is what
 * takes a path or a kebab-case identifier apart. Terminals keep these inside
 * a word so paths and URLs select whole; this set is what makes fullscreen's
 * own double-click agree with them.
 */
const WORD_JOINERS = new Set(["/", "-"]);

type WordSegment = {
	start: number;
	end: number;
	isWordLike: boolean;
	isJoiner: boolean;
	isSpace: boolean;
};

/** `segments[index]`, guaranteed — every call site here only ever passes an index it just found in range. */
function segmentAt(segments: readonly WordSegment[], index: number): WordSegment {
	const segment = segments[index];
	if (segment === undefined) {
		throw new RangeError(`word-select: no segment at index ${index}`);
	}
	return segment;
}

function collectWordSegments(line: string): WordSegment[] {
	const segments: WordSegment[] = [];
	let start = 0;
	for (const segment of wordSegmenter.segment(line)) {
		const text = segment.segment;
		const end = start + visibleWidth(text);
		segments.push({
			start,
			end,
			isWordLike: segment.isWordLike === true,
			// Joiners arrive one per segment, so `//` in a URL is two of these.
			isJoiner: text.length > 0 && [...text].every((char) => WORD_JOINERS.has(char)),
			isSpace: text.length > 0 && text.trim().length === 0,
		});
		start = end;
	}
	return segments;
}

/**
 * Walk back over a run of joiners that opens a word, as in `/usr` or `--flag`.
 *
 * The run only counts as part of the word when nothing but whitespace
 * precedes it, which is what separates a leading separator from an infix one.
 * In `http://a.com` the `//` is preceded by `:`, so the scheme stays out.
 */
function openingJoinerRun(segments: WordSegment[], first: number): number {
	let index = first;
	while (segments[index - 1]?.isJoiner) index--;
	if (index === first) return first;
	const before = segments[index - 1];
	return before === undefined || before.isSpace ? index : first;
}

/**
 * Grow a word segment across joiners that have a word on both sides, plus any
 * separator run that opens it.
 *
 * Anchoring on word-like segments is what keeps this conservative: in
 * `http://a.com/b` the `:` is not a joiner, so the run stops there instead of
 * swallowing the scheme, and a dash used as prose punctuation in `a - b` has
 * whitespace around it rather than a word.
 */
function expandOverWordJoiners(
	segments: WordSegment[],
	index: number,
): { start: number; end: number } {
	const anchor = segmentAt(segments, index);
	if (anchor.isJoiner) {
		// Clicking a separator should take the word it belongs to. Prefer the
		// word on the left so an infix `/` grows the whole path; failing that,
		// step over the run to the word it opens, so clicking the `/` of
		// `/usr/bin` works.
		if (segments[index - 1]?.isWordLike && segments[index + 1]?.isWordLike) {
			return expandOverWordJoiners(segments, index - 1);
		}
		if (!segments[index - 1]?.isWordLike) {
			let next = index;
			while (segments[next]?.isJoiner) next++;
			if (segments[next]?.isWordLike) return expandOverWordJoiners(segments, next);
		}
	}
	if (!anchor.isWordLike) return { start: anchor.start, end: anchor.end };

	let first = index;
	while (first >= 2 && segments[first - 1]?.isJoiner && segments[first - 2]?.isWordLike) {
		first -= 2;
	}
	first = openingJoinerRun(segments, first);
	// A trailing run gets no such treatment: nothing follows it to make it
	// part of the word, and `trailing- x` reading as `trailing-` would be
	// wrong.
	let last = index;
	while (segments[last + 1]?.isJoiner && segments[last + 2]?.isWordLike) {
		last += 2;
	}
	return { start: segmentAt(segments, first).start, end: segmentAt(segments, last).end };
}

/**
 * The column range a double click at `column` on `line` should select, in
 * the same column units as Pi's own `SelectionRange`. `undefined` when
 * `column` lands past the end of the line — the caller calls through to Pi's
 * own selection in that case rather than inventing a range.
 */
export function wordRangeAt(
	line: string,
	column: number,
): { start: number; end: number } | undefined {
	const segments = collectWordSegments(line);
	for (let index = 0; index < segments.length; index++) {
		const segment = segmentAt(segments, index);
		if (column < segment.start || column >= segment.end) continue;
		return expandOverWordJoiners(segments, index);
	}
	return undefined;
}
