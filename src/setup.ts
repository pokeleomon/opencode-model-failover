// Setup helpers: host diagnosis + JSONC-preserving Ollama config merge.
// Binding constraints: never write raw keys ({env:VAR} only — this module
// only touches providers.ollama paths and leaves /key|token|secret/i keys
// alone); Windows+macOS+Linux (Node only, no shell scripts); every setup
// step is skippable and re-runnable (merge is idempotent, diagnose is
// read-only, guides are stateless text).

import * as os from "node:os";
import { execFile } from "node:child_process";
import { applyEdits, modify, parse } from "jsonc-parser";

export type HostDiagnosis = {
  ramGB: number;
  diskFreeGB: number;
  gpu: boolean;
  recommendation: string;
  warnings: Record<string, string>;
};

export const SMALL_MODEL = "qwen2.5-coder:7b";
export const ALT_SMALL_MODEL = "llama3.1:8b";
export const LARGE_MODEL = "qwen2.5-coder:14b";

// Approximate minimum RAM (GB) / disk (GB) per candidate local model.
const MODEL_REQUIREMENTS: ReadonlyArray<{ id: string; ramGB: number; diskGB: number }> = [
  { id: SMALL_MODEL, ramGB: 8, diskGB: 5 },
  { id: ALT_SMALL_MODEL, ramGB: 10, diskGB: 5 },
  { id: LARGE_MODEL, ramGB: 24, diskGB: 9 },
];

const GB = 1024 ** 3;

// 0 means "could not be measured" (df/wmic both unavailable); guides show
// it as unknown and disk-based warnings are skipped in that case.
function formatDisk(diskFreeGB: number): string {
  return diskFreeGB > 0 ? `${diskFreeGB} GB free disk` : "free disk unknown";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs }, (error, stdout) => {
        finish(error ? "" : String(stdout ?? ""));
      });
      child?.on?.("error", () => finish(""));
    } catch {
      finish("");
    }
  });
}

function parseDfMB(output: string): number {
  // `df -k <dir>`: last line, 4th column = Available in KiB.
  const lines = output.trim().split("\n");
  if (lines.length < 2) return 0;
  const parts = lines[lines.length - 1].trim().split(/\s+/);
  const availKiB = Number(parts[3]);
  if (!Number.isFinite(availKiB)) return 0;
  return round1(availKiB / 1024 / 1024);
}

function parseWmicFreeBytes(output: string): number {
  // `wmic ... get FreeSpace /value` lines look like `FreeSpace=123456789`.
  let best = 0;
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^FreeSpace=(\d+)\s*$/i);
    if (match) best = Math.max(best, Number(match[1]));
  }
  if (!Number.isFinite(best) || best <= 0) return 0;
  return round1(best / GB);
}

async function diskFreeGB(): Promise<number> {
  // df first, wmic as fallback (brief order); never throws.
  try {
    const df = await runCapture("df", ["-k", os.homedir()], 5000);
    const fromDf = df ? parseDfMB(df) : 0;
    if (fromDf > 0) return fromDf;
  } catch {
    // Fall through to wmic.
  }
  try {
    const drive = os.homedir().slice(0, 2); // e.g. "C:"
    const where = /^[A-Za-z]:$/.test(drive) ? `DeviceID='${drive}'` : "DriveType=3";
    const out = await runCapture("wmic", ["logicaldisk", "where", where, "get", "FreeSpace", "/value"], 5000);
    const fromWmic = out ? parseWmicFreeBytes(out) : 0;
    if (fromWmic > 0) return fromWmic;
  } catch {
    // No disk info available.
  }
  return 0;
}

async function hasGpu(): Promise<boolean> {
  // Best-effort only; default false. nvidia-smi exists on all three OSes
  // when an NVIDIA GPU is present; anything else is conservatively "no GPU".
  try {
    const out = await runCapture("nvidia-smi", ["-L"], 3000);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Optional overrides exist only so tests can pin values without touching
// real hardware; normal callers use diagnoseHost().
export async function diagnoseHost(overrides?: {
  ramGB?: number;
  diskFreeGB?: number;
  gpu?: boolean;
}): Promise<HostDiagnosis> {
  let ramGB = overrides?.ramGB;
  let disk = overrides?.diskFreeGB;
  let gpu = overrides?.gpu;
  try {
    if (ramGB === undefined) ramGB = round1(os.totalmem() / GB);
  } catch {
    ramGB = 0;
  }
  try {
    if (disk === undefined) disk = await diskFreeGB();
  } catch {
    disk = 0;
  }
  try {
    if (gpu === undefined) gpu = await hasGpu();
  } catch {
    gpu = false;
  }
  const haveRam = ramGB ?? 0;
  const haveDisk = disk ?? 0;
  const haveGpu = gpu ?? false;

  // <24GB RAM or no GPU -> small-class default, else the 14b-class default.
  const recommendation = haveRam >= 24 && haveGpu ? LARGE_MODEL : SMALL_MODEL;

  const warnings: Record<string, string> = {};
  for (const req of MODEL_REQUIREMENTS) {
    const problems: string[] = [];
    if (haveRam > 0 && haveRam < req.ramGB) {
      problems.push(`needs ~${req.ramGB} GB RAM, you have ${haveRam} GB`);
    }
    if (haveDisk > 0 && haveDisk < req.diskGB) {
      problems.push(`needs ~${req.diskGB} GB free disk, you have ${haveDisk} GB`);
    }
    if (!haveGpu && req.id === LARGE_MODEL) {
      problems.push(`no GPU detected — ${req.id} will be slow on CPU`);
    }
    if (problems.length > 0) warnings[req.id] = problems.join("; ");
  }
  return { ramGB: haveRam, diskFreeGB: haveDisk, gpu: haveGpu, recommendation, warnings };
}

// Merge an Ollama provider entry into opencode config text, preserving
// JSONC comments and every unrelated provider. Only providers.ollama paths
// are written; keys matching /key|token|secret/i are never read or written
// (they are simply left alone). Idempotent: re-running with the same modelID
// yields an equivalent config. The caller handles backup + diff preview.
export function mergeOllamaConfig(existingText: string, modelID: string): string {
  let text = existingText;
  if (text.trim() === "") text = "{}";

  const set = (path: (string | number)[], value: unknown) => {
    text = applyEdits(text, modify(text, path, value, {}));
  };

  const parsed = parse(text) as Record<string, unknown> | undefined;
  const providers =
    parsed && typeof parsed["providers"] === "object" && parsed["providers"] !== null
      ? (parsed["providers"] as Record<string, unknown>)
      : undefined;
  if (providers === undefined) {
    set(["providers"], {});
  }

  const reparsed = () => parse(text) as Record<string, unknown>;
  const ollama = (() => {
    try {
      const p = reparsed()["providers"] as Record<string, unknown> | undefined;
      const o = p?.["ollama"];
      return typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();

  if (typeof ollama["name"] !== "string") {
    set(["providers", "ollama", "name"], "Ollama");
  }
  set(["providers", "ollama", "package"], "@opencode/ai/providers/openai-compatible");
  set(["providers", "ollama", "settings", "baseURL"], "http://localhost:11434/v1");

  const existingEntry =
    typeof ollama["models"] === "object" &&
    ollama["models"] !== null &&
    typeof (ollama["models"] as Record<string, unknown>)[modelID] === "object"
      ? ((ollama["models"] as Record<string, unknown>)[modelID] as Record<string, unknown>)
      : {};
  const existingCaps =
    typeof existingEntry["capabilities"] === "object" && existingEntry["capabilities"] !== null
      ? (existingEntry["capabilities"] as Record<string, unknown>)
      : {};
  set(["providers", "ollama", "models", modelID], {
    ...existingEntry,
    name: modelID,
    limit: typeof existingEntry["limit"] === "object" ? existingEntry["limit"] : { context: 32768, output: 8192 },
    capabilities: { ...existingCaps, tools: true },
  });

  return text;
}

function installSteps(platform: string, preference: "auto" | "manual" | "ask"): string[] {
  const lines: string[] = [];
  if (platform === "win32") {
    if (preference !== "manual") {
      lines.push("- AUTOMATIC (fetches latest at runtime): `winget install -e --id Ollama.Ollama`, then restart your terminal so PATH picks up `ollama`, then `ollama serve` check.");
    }
    if (preference !== "auto") {
      lines.push("- MANUAL: download the latest installer at https://ollama.com/download/windows, run it, restart the terminal, verify with `ollama --version`.");
    }
  } else if (platform === "darwin") {
    if (preference !== "manual") {
      lines.push("- AUTOMATIC (fetches latest at runtime): `brew install ollama` (or `brew upgrade ollama` if already installed).");
    }
    if (preference !== "auto") {
      lines.push("- MANUAL: download the latest macOS build at https://ollama.com/download/mac, drag to Applications, verify with `ollama --version`.");
    }
  } else {
    if (preference !== "manual") {
      lines.push("- AUTOMATIC (fetches latest at runtime): `curl -fsSL https://ollama.com/install.sh | sh`.");
    }
    if (preference !== "auto") {
      lines.push("- MANUAL: latest Linux instructions at https://ollama.com/download/linux — copy-paste: `curl -fsSL https://ollama.com/install.sh | sh`, verify with `ollama --version`.");
    }
  }
  return lines;
}

// Pure guide text for /failover-setup. Stateless: re-running is safe, and
// every component offers automatic vs manual plus skip.
export function buildSetupGuide(
  diag: HostDiagnosis,
  opts?: { preference?: "auto" | "manual" | "ask"; platform?: string },
): string {
  const preference = opts?.preference ?? "ask";
  const platform = opts?.platform ?? (typeof process !== "undefined" ? process.platform : "unknown");
  const warnLines = Object.entries(diag.warnings).map(([id, w]) => `  - ${id}: ${w}`);
  return [
    `[model-failover] setup — host: ${diag.ramGB} GB RAM, ${formatDisk(diag.diskFreeGB)}, GPU: ${diag.gpu ? "yes" : "no"}.`,
    `Recommended local model: ${diag.recommendation} (recommendation only — every option below stays available).`,
    ...(warnLines.length > 0 ? ["Per-model warnings:", ...warnLines] : ["No per-model warnings for this host."]),
    `Reply per component with automatic / manual / skip (all steps skippable and re-runnable; run /failover-setup again any time).`,
    `1) Ollama binary:`,
    ...installSteps(platform, preference),
    `   Verify: \`ollama --version\`. Skip if already installed.`,
    `2) Local model pull (large download — GBs; defer OK):`,
    ...(preference !== "manual"
      ? [`- AUTOMATIC (fetches latest at runtime): \`ollama pull ${diag.recommendation}\`, then verify with \`ollama list\`.`]
      : []),
    ...(preference !== "auto"
      ? [`- MANUAL: \`ollama pull ${diag.recommendation}\` (or ${SMALL_MODEL} / ${ALT_SMALL_MODEL} / ${LARGE_MODEL}), then \`ollama list\` to confirm.`]
      : []),
    `3) Provider wiring (never clobbers your config):`,
    ...(preference !== "manual"
      ? [`- AUTOMATIC: merge providers.ollama via mergeOllamaConfig (package @opencode/ai/providers/openai-compatible, baseURL http://localhost:11434/v1) into project .opencode/opencode.json(c) if present else the global config — always back up (opencode.json.bak-<timestamp>), preserve JSONC comments, show the diff before writing.`]
      : []),
    ...(preference !== "auto"
      ? [`- MANUAL: add the providers.ollama entry yourself (same package + baseURL, model entry { name, limit, capabilities: { tools: true } }), keeping every other provider untouched.`]
      : []),
    `4) API keys for optional remotes (names only, never paste values here):`,
    ...(preference !== "manual"
      ? [`- AUTOMATIC: I tell you the variable name (e.g. OPENAI_API_KEY) and the persistent setter for this OS (Windows \`setx VAR "value"\`, macOS/Linux export in shell profile); config uses {env:VAR} only.`]
      : []),
    ...(preference !== "auto"
      ? [`- MANUAL: create the key at your provider dashboard, set it persistently for this OS, reference it as {env:VAR}. Or skip entirely for Ollama-only mode.`]
      : []),
    `   Paid models stay disabled for failover until you explicitly opt in. Say "skip" for Ollama-only.`,
    `5) Verify: run \`node scripts/check.mjs\`, then /failover-status. Pick a mode: /failover-auto or /failover-manual.`,
  ].join("\n");
}

// Pure report text for /failover-update: re-checks all four components.
export function buildUpdateReport(
  diag: HostDiagnosis,
  opts?: { platform?: string },
): string {
  const platform = opts?.platform ?? (typeof process !== "undefined" ? process.platform : "unknown");
  return [
    `[model-failover] update — re-checking all four components (re-runnable; nothing applied without your OK).`,
    `Host now: ${diag.ramGB} GB RAM, ${formatDisk(diag.diskFreeGB)}, GPU: ${diag.gpu ? "yes" : "no"}; recommended local model: ${diag.recommendation}.`,
    `1) Ollama binary: re-run \`ollama --version\`; upgrade with the same per-OS step as setup (${platform === "win32" ? "winget upgrade Ollama.Ollama" : platform === "darwin" ? "brew upgrade ollama" : "curl -fsSL https://ollama.com/install.sh | sh"}) or https://ollama.com/download.`,
    `2) Models: re-run \`ollama list\` and \`ollama pull ${diag.recommendation}\` to refresh the local model.`,
    `3) Providers: re-run \`node scripts/check.mjs\` to confirm providers.ollama is still merged; re-merge with backup + diff preview if the config drifted.`,
    `4) Keys: confirm env presence by NAME only (never values); rotate/persist via this OS setter; config keeps {env:VAR} only.`,
    `Finish with /failover-status.`,
  ].join("\n");
}
