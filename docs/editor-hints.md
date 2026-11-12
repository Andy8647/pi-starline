# Hints on the editor's top rule

The right end of the editor's top rule is Starline's hint slot: the vim mode,
`paste again to expand`, `N characters selected, ctrl+x to copy`, `ctrl+g to edit
in $EDITOR`. It costs no rows, because that rule is drawn whether or not anything
is said.

The editor hint API lets another extension write there. Starline's own hints keep
their order; yours join the same slot to the left of them, so when the rule is
narrow yours is the last thing to be cut.

`pi-ide-context` is the first user: while it holds a fresh selection it says what
the next prompt will carry, `5 lines selected in index.ts`, and clears the hint
when the selection goes stale.

## Using it

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorHintApi } from "pi-starline/types/editor-hint-api";

const hintApi = () =>
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-starline.editor-hint-api.v1")] as
		| EditorHintApi
		| undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		hintApi()?.setHint("my-ext", "3 files staged");
	});

	pi.on("session_shutdown", () => {
		hintApi()?.setHint("my-ext", null);
	});
}
```

Nothing else is needed: no import from Starline at runtime, no rendering, no
configuration. When Starline is not installed `hintApi()` is `undefined` and the
extension behaves exactly as before. Clear the hint when you have nothing to say;
an empty rule is the normal state.

## Rules of thumb

- One sentence, one line. It is a rule of body text wide, not a panel.
- Publish on change, not on a timer. Re-publishing the same string is free (no
  repaint), but a hint that changes every second costs a frame every second.
- Say what is true now, not what was true a moment ago. Clear it rather than leave
  a stale claim on the border.
- Several extensions can hold a hint at once; they are ordered by key, so your
  position is stable.

## Reference

`types/editor-hint-api.d.ts` in the package is the source of truth; summary:

| Member                                         | Shape                                             |
| ---------------------------------------------- | ------------------------------------------------- |
| `Symbol.for("pi-starline.editor-hint-api.v1")` | the `EditorHintApi` object on `globalThis`        |
| `api.version`                                  | `1`                                               |
| `api.setHint(key, text)`                       | `text` is a short string, or `null`/`""` to clear |

Text is flattened onto one line, stripped of control sequences and cut at 60
columns. Nerd Font glyphs are ordinary characters to Starline, so a hint may carry
an icon; it is drawn in the same muted colour as Starline's own hints. A blank key
is ignored. Repaints ride the footer's render loop, so the hint appears at the next
frame.
