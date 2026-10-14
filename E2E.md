# E2E verification — model failover (Windows, fresh-profile path, Ollama-missing)

Date (UTC): 2026-10-14. Host: Windows 11 Home 10.0.26300, Node v24.21.0,
31.4 GB RAM, C: ~104 GB free, NVIDIA GeForce RTX 5080 Laptop GPU present.
OpenCode 1.19.0 installed. Ollama: missing (no `ollama` on PATH) — manual
links path exercised (see Finding F2 context). Live global config was NEVER
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

- `isLimitError`: 429 JSON body → true (PASS); 400 `invalid-request` monthly-
  quota body → true (PASS); HTML 429 page → true (PASS); 401 invalid-key
  control → false (PASS).
- `pickNext` (`allowPaid: []`): after `freellmapi/auto` 429 → 
...[truncated 1587 chars]