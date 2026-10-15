---
name: model-failover
description: Use when OpenCode hits model usage or rate limits, needs an Ollama offline fallback, or needs failover setup and auto/manual toggle.
---

# Model failover

## When to use

| Signal | Meaning |
|---|---|
| Red limit error, 429, quota/usage-cap message | Current model is rate-limited |
| "5-hour" or monthly-limit notice | Session quota exhausted, fail over |
| User wants offline backup | Wire Ollama as local fallback |
| "not switching" / mode question | Check `/failover-status`, toggle mode |

## Commands

| Command | Effect |
|---|---|
| `/failover-setup` | Guided setup (re-runnable, every step skippable) |
| `/failover-status` | Mode, current model, exhausted set, storage |
| `/failover-auto` | Automatic switching on limit errors |
| `/failover-manual` | Suggest-only; never auto-switch |
| `/failover-use <provider/model>` | Pin session now (disables auto-return) |
| `/failover-recheck` | Re-evaluate expired remotes, return if better |
| `/failover-update` | Re-check all four setup components |

Say "switch to manual switching" → `/failover-manual`. Say "go automatic" → `/failover-auto`.

## Announce rule (load-bearing)

Every switch or suggestion is delivered to the session AND persisted to storage key `failover:last:<sessionID>` (durable record). If the user saw nothing (older host without session delivery), read the key on your next turn and surface it: old → new model, reason, mode, plus the flip hint (`/failover-manual` in auto mode, `/failover-auto` in manual mode). If the key is absent, nothing switched — say so. Never invent a switch the key does not record.

## Setup: auto vs manual per component

`/failover-setup` offers automatic / manual / skip for each of: (1) Ollama binary, (2) model pull, (3) provider wiring, (4) API keys. Automatic runs the merge with backup plus diff preview; manual gives copy-paste steps; skip defers (Ollama-only mode is valid).

## Paid opt-in

Paid models stay excluded until the user says `opt in <provider>/<model>` (or provider id). Record the opt-in; never auto-spend.

## Secrets

Config references `{env:VAR}` only. Name variables, never values. Persistent setters: Windows `setx VAR "value"`, macOS/Linux export in shell profile.

## Ollama per OS

| OS | Install |
|---|---|
| Windows | `winget install Ollama.Ollama` |
| macOS | `brew install ollama` |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |

Verify with `ollama --version`, then `ollama pull <model>` and `ollama list`.

## Verify

| Step | Command |
|---|---|
| Host preflight | `node scripts/check.mjs` |
| State | `/failover-status` |
| Return path | `/failover-recheck` |
