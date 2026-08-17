# @local/eldritch-footer

Installable **Pi** package: a custom statusline/footer that replaces the built-in one and
shows live **Kimi** and **Z.ai / GLM Coding Plan** quota meters alongside usage, context,
and thinking-level info.

Mirrors the look & feel of the original `eldritch-footer.ts` global extension, but packaged
so it can be toggled with a parametrized command — just like
[`pi-prompt-translate`](https://github.com/05kim/pi-prompt-translate).

## What it shows

```
~/.pi/agent │ ⎇ main │ ● session-name
vstup ↑12k · výstup ↓3k · cache 8k · cache-hity 95.0% · cena $0.012 · kontext ██░░░░ 23.0%/200k (auto)    glm-5.2 • high
z.ai · 5h okno ██░░░░░░░░ 18% (reset 30.7. 03:00) · týden █░░░░░░░░░ 9% (reset 4.8. 18:11) · hledání 3/200
prompt-translate input on · …
```

- **Line 1** — cwd (`~`-shortened) · git branch · session name
- **Line 2** — token stats (Czech labels), cost, context-progress bar + window, model + thinking level
- **Line 3** — provider quota meters (only for the active provider):
  - **Kimi** (`kimi-coding`) — `týden` + `5h okno` with used/limit, remaining, reset time
  - **Z.ai / GLM** (`zai-coding` / `zai-coding-cn`) — `5h okno` + `týden` percentages + monthly web-search count
- **Line 4** — extension statuses (anything set via `ctx.ui.setStatus`)

Color thresholds: green < 70 %, amber 70–90 %, red > 90 %.

## Install

This is a local-path package. Add it to `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    // …other packages…
    "/home/jara/.pi/extensions/eldritch-footer"
  ]
}
```

Or from the CLI:

```bash
pi install /home/jara/.pi/extensions/eldritch-footer
```

Then restart Pi (or `/reload`).

> Type-checking: the bundled `node_modules` (symlinks into the installed
> `@earendil-works/pi-coding-agent`) plus `tsconfig.json` let `tsc --noEmit` resolve all
> imports. At runtime Pi provides `pi-ai` / `pi-coding-agent` / `pi-tui` itself.

## Auth

Quota endpoints are polled with the API key Pi already stores for each provider in
`~/.pi/agent/auth.json`:

| Provider key read            | Meter shown |
|------------------------------|-------------|
| `kimi-coding`                | Kimi        |
| `zai-coding-cn` / `zai-coding` | Z.ai / GLM |

If a key is absent, that meter is simply omitted (the footer still renders).

Endpoints used (internal/undocumented, same ones the providers' own dashboards call):

- Kimi — `GET https://api.kimi.com/coding/v1/usages`
- Z.ai — `GET {host}/api/monitor/usage/quota/limit`
  - host auto-detected from `models-store.json` `baseUrl`: `open.bigmodel.cn` (CN) vs `api.z.ai` (global)

Polled every turn, cached for 60 s, 8 s timeout, best-effort (network/auth failures keep
stale data silently).

## Commands

```
/footer            # show status
/footer on         # enable (replace built-in footer)
/footer off        # disable (restore built-in footer)
/footer status     # same as bare /footer
/footer help       # usage
```

The on/off state is persisted to the session log, so it survives `/reload` and model
swaps within a session. New sessions default to **enabled**.

## Package layout

```
eldritch-footer/
├── package.json     # pi.extensions: ["./index.ts"], peerDeps on pi-ai / pi-coding-agent / pi-tui
├── index.ts         # the extension (default export factory)
├── tsconfig.json    # NodeNext resolution so tsc / LSP resolve the pi packages
└── node_modules/    # symlinks into the installed pi-coding-agent bundle (types only)
```

No runtime dependencies — Pi itself supplies the `@earendil-works/*` packages.
