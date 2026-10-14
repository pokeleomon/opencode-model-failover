#!/usr/bin/env node
// Failover preflight: REPORT ONLY. Never installs, never writes config,
// never prints secret values (env presence is reported by NAME only).
// Exit code is 0 even when ollama/opencode are missing — missing pieces are
// reported as lines, not thrown errors. Node only (Windows+macOS+Linux).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform, release } from "node:os";
import { join, resolve } from "node:path";

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolvePromise(value);
      }
    };
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) finish({ ok: false, out: String(stderr || error.message || "").trim() });
        else finish({ ok: true, out: String(stdout || "").trim() });
      });
      if (child && typeof child.on === "function") {
        child.on("error", (error) => finish({ ok: false, out: String((error && error.message) || error) }));
      }
    } catch (error) {
      finish({ ok: false, out: String((error && error.message) || error) });
    }
  });
}

// Env vars we check for PRESENCE ONLY. Values are never read into output.
const KNOWN_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
  "FREELLMAPI_KEY",
  "OPENCODEX_API_KEY",
];

function configCandidates() {
  const home = homedir();
  return [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    resolve(".opencode", "opencode.json"),
    resolve(".opencode", "opencode.jsonc"),
    resolve("opencode.json"),
    resolve("opencode.jsonc"),
  ];
}

async function probeOpencode() {
  const direct = await runCapture("opencode", ["--version"], 8000);
  if (direct.ok && direct.out) return direct;
  if (platform() === "win32") {
    // npm-style shims: a bare `opencode` may resolve to opencode.ps1, which
    // is NOT in PATHEXT, so direct spawn fails with ENOENT even though
    // shells resolve it. Try the .cmd sibling first (cheap, directly
    // spawnable), then PowerShell (resolves .ps1 on PATH).
    const viaCmd = await runCapture("opencode.cmd", ["--version"], 8000);
    if (viaCmd.ok && viaCmd.out) return viaCmd;
    const viaPs = await runCapture(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "opencode --version"],
      15000,
    );
    if (viaPs.ok && viaPs.out) return viaPs;
  }
  return direct;
}

async function main() {
  const lines = [];
  lines.push(`[failover-check] platform: ${platform()} ${release()}, node: ${process.version}`);

  const opencode = await probeOpencode();
  lines.push(
    opencode.ok && opencode.out
      ? `[failover-check] opencode version: ${opencode.out.split("\n")[0]}`
      : "[failover-check] opencode version: NOT FOUND on PATH (install/restart OpenCode, then re-run)",
  );

  const found = configCandidates().filter((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  lines.push(
    found.length > 0
      ? `[failover-check] config paths found:\n  - ${found.join("\n  - ")}`
      : "[failover-check] config paths found: none (fresh install — /failover-setup will create one)",
  );

  const ollamaVersion = await runCapture("ollama", ["--version"], 8000);
  lines.push(
    ollamaVersion.ok && ollamaVersion.out
      ? `[failover-check] ollama --version: ${ollamaVersion.out.split("\n")[0]}`
      : "[failover-check] ollama --version: NOT FOUND on PATH (see /failover-setup step 1)",
  );

  const ollamaList = await runCapture("ollama", ["list"], 15000);
  if (ollamaList.ok) {
    const body = ollamaList.out || "(no models pulled yet)";
    lines.push(`[failover-check] ollama list:\n${body.split("\n").map((l) => `  ${l}`).join("\n")}`);
  } else {
    lines.push("[failover-check] ollama list: unavailable (ollama binary missing or daemon not running — try `ollama serve`)");
  }

  const presence = KNOWN_ENV_NAMES.map((name) => `${name}=${process.env[name] ? "set" : "missing"}`);
  lines.push(`[failover-check] env presence (names only, never values): ${presence.join(", ")}`);

  console.log(lines.join("\n"));
}

try {
  await main();
} catch (error) {
  // Report, don't throw: exit 0 per spec even on total failure.
  console.log(`[failover-check] preflight failed to complete: ${String((error && error.message) || error)}`);
}
process.exit(0);
