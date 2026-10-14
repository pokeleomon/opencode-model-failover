# E2E verification — model failover (Windows, fresh-profile path, Ollama-missing)

Date (UTC): 2026-10-14. Host: Windows 11 Home 10.0.26300, Node v24.21.0,
31.4 GB RAM, C: ~104 GB free, NVIDIA GeForce RTX 5080 Laptop GPU present.
OpenCode 1.19.0 installed. Ollama: missing (no `ollama` on PATH) — manual
links path exercised (see Finding F2). Live global config was NEVER
written: SHA256 of `%USERPROFILE%\.config\opencode\opencode.json` before and
after all checks is `A5C07975…F482281` (identical); all merge work ran against
`%TEMP%` copies only. Scratch harness deleted after the run; this file is the
only artifact committed. Existing suite re-run green: 4 files, 17/17 pass.

## Step 1 — Fresh-profile install test (backup + restore check)

- Backup: copied live `opencode.json` (38,963 bytes) to
  `%TEMP%\opencode-backup.json`; hashes matched at backup time.
- `node opencode-model-failover/scripts/check.mjs` → exit **0** (PASS).
  Output: platform win32 10.0.26300 + node v24.21.0; config paths found (global
  + project `.opencode/opencode.json`); `ollama --version: NOT FOUND on PATH
  (see /failover-setup step 1)`; `ollama list: unavailable (… try
  \`ollama serve\`)`; env presence names-only, all five missing.
  Ollama-missing is reported, NOT thrown (PASS). See Finding F1: the
  `opencode version: NOT FOUND on PATH` line is a false negative on Windows
  (OpenCode 1.19.0 is installed) — report-only defect, exit code unaffected.
- Merge simulation: `mergeOllamaConfig(backupCopyText, "qwen2.5-coder:7b")`.
  `git diff --no-index backup merged` shows exactly ONE hunk, inside
  `providers.ollama.models` only: existing `qwen2.5-coder:14b` entry
  byte-preserved, new `qwen2.5-coder:7b` entry
  (`{name, limit:{context:32768,output:8192}, capabilities:{tools:true}}`)
  appended; `name: "Ollama (local)"` preserved; unrelated providers
  (opencodex 15 models, freellmapi auto/fusion) untouched (PASS).
  Re-merge is byte-identical → idempotent (PASS). Parsed `providers.ollama`
  subtree contains no `key/token/secret` fields; `{env:…}` refs elsewhere
  preserved and no raw keys written by the merge (PASS). Synthetic JSONC
  sample: `// user` + `// provider` comments survive the merge (PASS).
  (Backup has no comments — strict-JSON parse succeeds — so comment
  preservation was proven on the synthetic sample.)
- Restore: live file verified byte-identical by SHA256 after all steps, so no
  restore write was performed (writing it back would violate the never-write-
  live rule; identical hash = nothing to restore). PASS.

## Step 2 — Simulated limit test (no spend, simulation only)

Candidate set mirrors the user's real providers: `opencodex/gpt-5.6-luna`
(free), `freellmapi/auto` (free), `freellmapi/fusion` (custom),
`openai/gpt-5` (paid, no opt-in), `ollama/qwen2.5-coder:14b` (local).
Scratch harness (bundled from `src/*.ts` via esbuild, run, then deleted —
never committed) called the real `isLimitError`, `pickNext`,
`shouldReturnFromOffline`, and `buildAnnouncement`.

- `isLimitError`: 429 JSON body → true (PASS); 400 `invalid-request` monthly-
  quota body → true (PASS); HTML 429 page → true (PASS); 401 invalid-key
  control → false (PASS).
- `pickNext` (`allowPaid: []`): after `freellmapi/auto` 429 →
  `opencodex/gpt-5.6-luna` (PASS); both frees exhausted → `freellmapi/fusion`
  custom (PASS); all remotes exhausted → `ollama/qwen2.5-coder:14b` local
  (PASS). Paid-only-vs-local set → local wins, paid correctly skipped without
  opt-in (PASS). With opt-in `allowPaid: ["openai"]` → paid eligible but still
  ranked behind free/custom (PASS).
- `shouldReturnFromOffline` (local `ollama/qwen2.5-coder:14b`): strong remote
  (`freellmapi/auto`, tools true, ctx 128k) → true, returns (PASS); remote
  with `tools: false` → false, stays local (PASS); remote with context < 32k
  → false, stays local (PASS); no remote recovered → false (PASS).
- `buildAnnouncement` text samples (all present with mode tag + flip hint):
  - auto: `[model-failover:auto] freellmapi/auto hit rate limit (429): Rate
    limit exceeded; switched to opencodex/gpt-5.6-luna. Reply "switch to
    manual" or run /failover-manual to stop auto-switching.` (PASS)
  - exhausted-all: `[model-failover:auto] freellmapi/fusion hit usage limit:
    monthly quota exhausted. All remotes exhausted; staying on local
    ollama/qwen2.5-coder:14b (offline mode, no usage limits). Reply "switch
    to manual" or run /failover-manual to stop auto-switching.` (PASS)
  - manual-suggest (no switch claim): `[model-failover:manual]
    freellmapi/auto hit rate limit (429): slow down. Top candidate:
    opencodex/gpt-5.6-luna. Switch with /failover-use opencodex/gpt-5.6-luna.
    Run /failover-auto to resume automatic switching.` (PASS)
- `diagnoseHost()` live: 31.4 GB RAM, disk unmeasurable (see O1), GPU true →
  recommends `qwen2.5-coder:14b`, warnings `{}` (PASS, sane).

## Findings (recorded, NOT fixed — fixes belong to owning tasks)

- **F1 (defect, `scripts/check.mjs`, severity low-medium, routed to Task 3):**
  on Windows where OpenCode installs as an `opencode.ps1` shim, Node
  `execFile("opencode", …)` fails with ENOENT (no PATHEXT/`.ps1` resolution
  without `shell:true`), so check.mjs prints `opencode version: NOT FOUND on
  PATH` even though OpenCode 1.19.0 is installed and works. Proven via
  `Get-Command opencode → opencode.ps1` plus direct `execFile` → ENOENT.
  Report-only impact (exit code stays 0); fix (e.g. `opencode.cmd` / PowerShell
  fallback) is out of Task 5 scope.
- **F2 (environment, not a defect):** Ollama is genuinely absent on this host,
  so this E2E covers the ollama-missing branch only; live `ollama pull` /
  `serve` paths remain unverified here (the manual-install-links path is what
  the setup guide shows for this case).
- **O1 (observation, by design):** `diagnoseHost` reports `diskFreeGB: 0`
  (unknown) on Win11 where `df` is absent and `wmic` returns nothing
  (deprecated); guides render "free disk unknown" and skip disk warnings — no
  action, spec-compliant (`0 = could not be measured`).
- **O2 (observation, pre-existing user config, untouched):** live
  `providers.freellmapi` uses a literal `apiKey` value rather than `{env:…}`;
  the merge correctly left it alone. No secret values recorded anywhere in
  this file. Rotating it to `{env:…}`-style is suggested out of band (not
  Task 5 scope).

## Step 3 — Results record and commit

| Check | Result |
|---|---|
| check.mjs exit 0, ollama-missing reported not thrown | PASS (F1 noted) |
| Merge diff: only `providers.ollama` added/changed | PASS |
| Merge idempotent; comments + unrelated providers intact | PASS |
| No raw keys written by merge; live config never written | PASS |
| `isLimitError` 429/400-quota/HTML-429 true, 401 false | PASS |
| `pickNext`: free → custom → local; paid skipped w/o opt-in | PASS |
| `shouldReturnFromOffline` strong/weak/undefined | PASS |
| `buildAnnouncement` auto / exhausted-all / manual text | PASS |
| Existing suite 17/17 | PASS |

Verdict: **PASS WITH FINDINGS** (F1 routed to Task 3; F2/O1/O2 informational).
Committed via `git add opencode-model-failover/E2E.md` +
`git commit -m "test(failover): e2e on windows fresh profile"` (d3ef6d8);
completion fix committed as `test(failover): complete e2e evidence`.
