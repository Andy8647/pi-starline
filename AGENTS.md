## What this app is

Starline is a Pi extension package that gives Pi a Starship-inspired footer and an Opencode-style input UI.

It shows useful session/project state at a glance:

- current directory
- git branch and git status
- detected runtime/language and version
- context usage
- input/output token counts
- running session cost

## How it works

Pi loads the package from `package.json` via:

```json
"pi": {
  "extensions": ["./extensions"]
}
```

The extension entry point is:

```text
extensions/starline/index.ts
```

On `session_start`, Starline installs:

- a custom footer (`footer.ts`)
- a custom editor (`ui.ts`)
- a project refresh timer for git/runtime status

Most updates happen by syncing shared footer state and asking the TUI to re-render after Pi events like model changes, message completion, tool completion, and compaction.

## Important files

- `extensions/starline/index.ts` — extension orchestration and Pi event wiring.
- `extensions/starline/config.ts` — config file path, defaults, and config merging.
- `extensions/starline/footer.ts` — footer/statusline rendering.
- `extensions/starline/style.ts` — Starship-style terminal style rendering (`bold purple`, `fg:202`, `bg:blue`, etc.).
- `extensions/starline/format.ts` — small formatting helpers for counts, labels, context, cwd, and runtime segments.
- `extensions/starline/state.ts` — footer state shape and sync logic.
- `extensions/starline/git.ts` — git porcelain parsing and status summary.
- `extensions/starline/runtime.ts` — runtime/language detection and version lookup.
- `extensions/starline/settings-command.ts` — `/starline` settings UI for color-source preferences.
- `extensions/starline/ui.ts` — custom editor frame.

## Config

User config is created at:

```text
~/.pi/agent/starline.json
```

Use `colors` for Starship-style color strings, hex/256-color values, or Pi theme tokens. `colorSources` controls whether Starline maps colors through the Pi theme or renders terminal colors directly. User messages are pi-tidy's to style, not Starline's.

## Things to preserve

- Keep `index.ts` mostly orchestration; put rendering/formatting logic in focused modules.
- Preserve Nerd Font icons. Many are private-use Unicode characters and can be easy to accidentally replace with empty strings.
- Runtime color values should follow Starship's terminal style strings.
- Silent fallbacks are intentional for git/runtime/config failures so the UI does not break the session.

## Development

Use these commands before shipping changes:

```bash
npm run fmt
npm run verify
npm run pack:check
```

For local Pi testing:

```bash
npm run pi:dev
npm run pi:install-local
```

## Commit style

Use conventional commit messages that match the existing history:

```text
feat: add user-facing capability
```

Keep the subject lowercase after the type, imperative, and concise. Do not use a trailing period.
