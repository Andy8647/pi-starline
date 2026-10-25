/**
 * Starship-style format string parser.
 *
 * Pure module (no TUI/config imports) so it is fully unit-testable. The only
 * consumer is `editorMetadataFormat`; the footer is built from `pill.segments`
 * and has no template.
 *
 * Supports conditional groups: `( ... )` is dropped when every nested
 * variable (and nested group) renders empty.
 */

export type FormatToken =
	| { kind: "text"; value: string }
	| { kind: "var"; name: string }
	| { kind: "fill" }
	| { kind: "group"; tokens: FormatToken[] };

const TOKEN_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Tokenize a format string into text/var/fill/group tokens.
 *
 * `$name` and `${name}` both produce a variable token. A variable named
 * `fill` becomes a fill token instead. Parentheses form conditional groups
 * that drop entirely when all nested vars are empty.
 */
export function parseFooterFormat(format: string): FormatToken[] {
	if (!format) return [];
	return parseTokenSlice(format, 0, format.length, true).tokens;
}

function parseTokenSlice(
	format: string,
	start: number,
	end: number,
	topLevel = false,
): { tokens: FormatToken[]; nextIndex: number } {
	const tokens: FormatToken[] = [];
	let index = start;
	let textStart = start;

	const flushText = (until: number) => {
		if (until > textStart) {
			tokens.push({ kind: "text", value: format.slice(textStart, until) });
		}
	};

	while (index < end) {
		const ch = format[index];

		if (ch === "(") {
			flushText(index);
			const nested = parseTokenSlice(format, index + 1, end, false);
			tokens.push({ kind: "group", tokens: nested.tokens });
			index = nested.nextIndex;
			textStart = index;
			continue;
		}

		if (ch === ")") {
			// Nested groups close on `)`. Unmatched top-level `)` is literal text so
			// trailing tokens like `$cwd) $tokens` are not discarded.
			if (topLevel) {
				index += 1;
				continue;
			}
			flushText(index);
			return { tokens, nextIndex: index + 1 };
		}

		if (ch === "$") {
			TOKEN_REGEX.lastIndex = index;
			const match = TOKEN_REGEX.exec(format);
			if (match && match.index === index && match.index < end) {
				const full = match[0];
				const matchEnd = match.index + full.length;
				if (matchEnd > end) {
					index += 1;
					continue;
				}
				flushText(index);
				const name = match[1] ?? match[2] ?? "";
				if (name === "fill") {
					tokens.push({ kind: "fill" });
				} else {
					tokens.push({ kind: "var", name });
				}
				index = matchEnd;
				textStart = index;
				continue;
			}
		}

		index += 1;
	}

	flushText(end);
	return { tokens, nextIndex: end };
}
