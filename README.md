# opencode-model-failover

Automatic model failover for OpenCode: when the current model hits a usage or rate limit, switch to the next available model (or a local Ollama fallback) and announce the switch. Manual-suggest mode, explicit pinning, and offline return included.

> Package name: `opencode-model-failover`. Do not confuse with `opencode-failover` — that name is not this plugin.

## Fresh-machine path

1. Install (pick one form below).
2. Restart the service so the plugin loads: `opencode service restart`.
3. Preflight: `node scripts/check.mjs` (from this package directory).
4. In OpenCode, run `/failover-setup` (guided, re-runnable, every step skippable), then `/failover-status` to confirm.
5. Pick a mode: `/failover-auto` (automatic) or `/failover-manual` (suggest-only).

## Install

Plugin add:

```sh
opencode plugin add opencode-model-failover
```

Local path — add to the `plugins` list in your OpenCode config:

```jsonc
{
  "plugins": ["./opencode-model-failover"]
}
```

Then restart:

```sh
opencode service restart
```

## Commands

Stubs live in `commands/` (names match the registered plugin commands exactly):

| Command | Effect |
|---|---|
| `/failover-setup` | Guided setup: Ollama binary, model pull, provider wiring, keys |
| `/failover-status` | Mode, exhaustion set, last announcement |
| `/failover-auto` | Enable automatic switching |
| `/failover-manual` | Suggest-only mode |
| `/failover-use <provider/model>` | Pin session to a model now |
| `/failover-recheck` | Re-evaluate remotes, return from offline if better |
| `/failover-update` | Re-check all four setup components |

Paid models stay excluded until you say `opt in <provider>/<model>`. Secrets use `{env:VAR}` references only — never paste values. The retry hook stores announcements at `failover:last:<sessionID>`; the agent surfaces them on its next turn.

## Version note

Targets OpenCode V2 plugin APIs with feature detection: on hosts without the retry hook or `switchModel` (e.g. OpenCode 1.19.0) the plugin degrades to manual-suggest-only — `/failover-status`, `/failover-use` guidance, and `/failover-recheck` still work; automatic switching does not.

Limitation: the prompt hook carries no current-model field, so auto-return cannot see a manual `/model` switch made outside the plugin and may switch back once per scope — `/failover-use` pins the session and is never overridden.
