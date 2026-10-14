import { Plugin } from "@opencode/plugin";
import {
  cooldownMsFor,
  isLimitError,
  pickNext,
  shouldReturnFromOffline,
  type Candidate,
} from "./failover.js";
import { getMode, setMode, type FailoverMode } from "./mode.js";
import { buildSetupGuide, buildUpdateReport, diagnoseHost } from "./setup.js";

// Storage keys (all under ctx.storage):
//   failover:mode                 "auto" | "manual" (see mode.ts)
//   failover:exhausted:<id>       epoch-ms expiry for a limit-hit model
//   failover:hops:<sessionID>     failover hop count, reset on each new prompt
//   failover:pinned:<sessionID>   model id the user explicitly chose (wins over auto)
//   failover:current:<sessionID>  last model this plugin switched to
//   failover:last:<sessionID>     last announcement payload for the agent turn
//   failover:returned:<scope>     one-shot flag for auto-return per prompt/recheck
//
// Note: the retry event carries a sessionID but no prompt/message id, so the
// "max 3 hops per prompt" counter is keyed by session and reset by the prompt
// hook, which fires once per new prompt.

const EXHAUSTED_PREFIX = "failover:exhausted:";
const HOPS_PREFIX = "failover:hops:";
const PIN_PREFIX = "failover:pinned:";
const CURRENT_PREFIX = "failover:current:";
const LAST_PREFIX = "failover:last:";
const RETURNED_PREFIX = "failover:returned:";

const MAX_HOPS = 3;

// Minimal structural view of the plugin context. Every capability is
// feature-detected so the shell degrades to manual-suggest-only on hosts
// where the retry hook or switchModel is missing (e.g. OpenCode 1.19.0).
type Ctx = {
  options?: Record<string, unknown>;
  storage?: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: never) => Promise<void>;
    remove: (key: string) => Promise<void>;
    scan: (options: { prefix: string }) => Promise<{ entries: readonly { key: string; value: unknown }[] }>;
  };
  session?: {
    hook?: (name: string, cb: (event: never) => Promise<void> | void) => Promise<unknown>;
    switchModel?: (input: {
      sessionID: string;
      model: { providerID: string; id: string };
    }) => Promise<unknown>;
  };
  command?: {
    transform?: (cb: (editor: { add: (def: CommandDef) => void }) => void) => Promise<unknown>;
  };
  model?: {
    list?: (input?: unknown) => Promise<unknown> | unknown;
  };
};

type CommandDef = {
  name: string;
  description?: string;
  execute: (input: { sessionID: string; prompt: { text?: unknown } }) => Promise<void>;
};

type RetryEvent = {
  sessionID: string;
  model: { providerID: string; id: string };
  error: { type?: string; message?: string; status?: number; response?: { body?: string } };
  decision: unknown;
};

function readAllowPaid(options: Record<string, unknown> | undefined): string[] {
  const raw = options?.["allowPaid"];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function fullId(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

function classifyKind(
  providerID: string,
  id: string,
  modelID: string,
  explicit: unknown,
  allowPaid: string[],
): Candidate["kind"] {
  if (explicit === "free" || explicit === "custom" || explicit === "paid" || explicit === "local") {
    return explicit;
  }
  if (providerID === "ollama") return "local";
  if (allowPaid.includes(id) || allowPaid.includes(providerID) || allowPaid.includes(modelID)) {
    return "paid";
  }
  return "free";
}

function parseModelRef(text: string): { providerID: string; modelID: string } | undefined {
  const token = text
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith("/"))
    .find((t) => t !== "failover-use");
  if (!token) return undefined;
  const slash = token.indexOf("/");
  if (slash > 0) {
    return { providerID: token.slice(0, slash), modelID: token.slice(slash + 1) };
  }
  return { providerID: "", modelID: token };
}

// Candidate registry: static plugin options merged best-effort with the live
// model list when the host exposes one. Never throws.
async function resolveCandidates(ctx: Ctx, allowPaid: string[]): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();
  const push = (providerID: string, modelID: string, kind: unknown, raw?: Record<string, unknown>) => {
    const id = fullId(providerID, modelID);
    if (!out.has(id)) {
      const candidate: Candidate = {
        id,
        providerID,
        modelID,
        kind: classifyKind(providerID, id, modelID, kind, allowPaid),
      };
      // Carry capability caps through so shouldReturnFromOffline can tell a
      // weak remote (tools:false / small context) from a strictly-better one.
      if (typeof raw?.["tools"] === "boolean") candidate.tools = raw["tools"];
      if (typeof raw?.["context"] === "number") candidate.context = raw["context"];
      out.set(id, candidate);
    }
  };

  try {
    const rawModels = ctx.options?.["models"];
    if (Array.isArray(rawModels)) {
      for (const m of rawModels) {
        if (typeof m !== "object" || m === null) continue;
        const rec = m as Record<string, unknown>;
        const providerID = rec["providerID"];
        const modelID = rec["modelID"];
        if (typeof providerID !== "string" || typeof modelID !== "string") continue;
        push(providerID, modelID, rec["kind"], rec);
      }
    }
    const localModel = ctx.options?.["localModel"];
    if (typeof localModel === "string" && localModel.includes("/")) {
      const slash = localModel.indexOf("/");
      push(localModel.slice(0, slash), localModel.slice(slash + 1), "local");
    }
  } catch {
    // Options are untrusted input; ignore malformed entries.
  }

  try {
    const list = ctx.model?.list;
    if (typeof list === "function") {
      const result = await list.call(ctx.model, {});
      const items = Array.isArray(result)
        ? result
        : (result as { data?: unknown })?.data && Array.isArray((result as { data: unknown }).data)
          ? ((result as { data: unknown[] }).data as unknown[])
          : [];
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const providerID = rec["providerID"];
        // Live model infos use `id` for the model id (Model.Ref shape).
        const modelID = rec["id"] ?? rec["modelID"];
        if (typeof providerID !== "string" || typeof modelID !== "string") continue;
        push(providerID, modelID, rec["kind"] ?? (providerID === "ollama" ? "local" : undefined), rec);
      }
    }
  } catch {
    // Live listing is best-effort; fall back to the static registry.
  }

  return [...out.values()];
}

async function readExhausted(
  storage: NonNullable<Ctx["storage"]>,
  now: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const result = await storage.scan({ prefix: EXHAUSTED_PREFIX });
    for (const entry of result.entries ?? []) {
      const id = entry.key.slice(EXHAUSTED_PREFIX.length);
      const expiry = typeof entry.value === "number" ? entry.value : NaN;
      if (Number.isFinite(expiry) && expiry > now) {
        map.set(id, expiry);
      } else {
        // Drop stale entries so they stop shadowing recovered remotes.
        try {
          await storage.remove(entry.key);
        } catch {
          // Cleanup is best-effort.
        }
      }
    }
  } catch {
    // Storage scan failing means "nothing known exhausted".
  }
  return map;
}

export type AnnouncementInput = {
  oldModel: string;
  newModel?: string;
  reason: string;
  mode: FailoverMode;
  exhaustedAll?: boolean;
  localOnly?: boolean;
  suggestion?: string;
};

// Pure helper: every failover path builds one of these so the hook is never
// silent. The payload is stored at failover:last:<sessionID> for the agent
// turn (a retry hook cannot inject chat text on its own) and surfaced by
// /failover-status.
export function buildAnnouncement(input: AnnouncementInput): string {
  const flipHint =
    input.mode === "auto"
      ? 'Reply "switch to manual" or run /failover-manual to stop auto-switching.'
      : "Run /failover-auto to resume automatic switching.";
  if (input.exhaustedAll) {
    const tail = input.localOnly
      ? `All remotes exhausted; staying on local ${input.newModel ?? "Ollama"} (offline mode, no usage limits).`
      : "All remotes exhausted and no local model is configured; stopped with this summary.";
    return `[model-failover:${input.mode}] ${input.oldModel} hit ${input.reason}. ${tail} ${flipHint}`;
  }
  if (input.newModel) {
    return `[model-failover:${input.mode}] ${input.oldModel} hit ${input.reason}; switched to ${input.newModel}. ${flipHint}`;
  }
  return `[model-failover:${input.mode}] ${input.oldModel} hit ${input.reason}. ${input.suggestion ?? ""} ${flipHint}`.trim();
}

function describeReason(status: number | undefined, message: string): string {
  if (status === 429) return `rate limit (429): ${message.slice(0, 160)}`;
  return `usage limit: ${message.slice(0, 160)}`;
}

async function recordAnnouncement(ctx: Ctx, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.storage?.set((LAST_PREFIX + sessionID) as string, text as never);
  } catch {
    // Announcement persistence is best-effort.
  }
}

async function handleRetry(ctx: Ctx, event: RetryEvent): Promise<void> {
  const storage = ctx.storage;
  if (!storage) return;
  const err = event.error ?? {};
  const status = typeof err.status === "number" ? err.status : undefined;
  const message = err.message ?? err.response?.body ?? "";
  const code = err.type ?? "";
  if (!isLimitError({ status, message, code })) return;

  // Don't burn the failing model again for this error class.
  event.decision = { retry: false };

  const now = Date.now();
  const currentId = fullId(event.model.providerID, event.model.id);
  const mode: FailoverMode = await getMode(storage, (ctx.options ?? {}) as { mode?: string }).catch(
    () => "auto" as FailoverMode,
  );
  try {
    await storage.set(
      (EXHAUSTED_PREFIX + currentId) as string,
      (now + cooldownMsFor({ status, message })) as never,
    );
  } catch {
    // If we cannot persist exhaustion, still try to move the session on.
  }

  const allowPaid = readAllowPaid(ctx.options);
  const exhausted = await readExhausted(storage, now);
  const candidates = await resolveCandidates(ctx, allowPaid);
  const reason = describeReason(status, message);
  const next = pickNext(candidates, exhausted, { allowPaid, now });

  const canSwitch = typeof ctx.session?.switchModel === "function";
  // A surviving local is an "Ollama-only" outcome, not a normal hop:
  // announce honestly that all remotes are exhausted (anti-goal: no
  // confusing silent switches). pickNext returns undefined only when
  // nothing usable remains at all.
  const ollamaOnly = !next || next.kind === "local";
  if (ollamaOnly) {
    // All exhausted: honest Ollama-only announcement. Prefer a surviving
    // local; otherwise stop with a summary (never fake "offline").
    const local = next?.kind === "local" ? next : candidates.find((c) => c.kind === "local");
    if (local && local.id !== currentId && canSwitch) {
      try {
        await ctx.session?.switchModel?.({
          sessionID: event.sessionID,
          model: { providerID: local.providerID, id: local.modelID },
        });
        try {
          await storage.set((CURRENT_PREFIX + event.sessionID) as string, local.id as never);
        } catch {
          // Tracking write is best-effort.
        }
      } catch {
        // Switching failed; the announcement below still tells the truth.
      }
    }
    await recordAnnouncement(
      ctx,
      event.sessionID,
      buildAnnouncement({
        oldModel: currentId,
        newModel: local?.id,
        reason,
        mode,
        exhaustedAll: true,
        localOnly: local !== undefined,
      }),
    );
    return;
  }

  const hopsKey = HOPS_PREFIX + event.sessionID;
  let hops = 0;
  try {
    const raw = await storage.get(hopsKey);
    hops = typeof raw === "number" ? raw : 0;
  } catch {
    hops = 0;
  }
  if (hops >= MAX_HOPS) {
    await recordAnnouncement(
      ctx,
      event.sessionID,
      buildAnnouncement({
        oldModel: currentId,
        reason: `${reason} (stopped after ${MAX_HOPS} failover hops this prompt to avoid loops; next candidate would be ${next.id})`,
        mode,
        suggestion: `Switch manually with /failover-use ${next.id} if you want to continue.`,
      }),
    );
    return;
  }

  if (mode === "manual" || !canSwitch) {
    await recordAnnouncement(
      ctx,
      event.sessionID,
      buildAnnouncement({
        oldModel: currentId,
        reason,
        mode: canSwitch ? mode : "manual",
        suggestion: `Top candidate: ${next.id}. Switch with /failover-use ${next.id}.`,
      }),
    );
    return;
  }

  try {
    await storage.set(hopsKey as string, (hops + 1) as never);
  } catch {
    // Hop accounting is best-effort; continue with the switch.
  }
  try {
    await ctx.session?.switchModel?.({
      sessionID: event.sessionID,
      model: { providerID: next.providerID, id: next.modelID },
    });
    try {
      await storage.set((CURRENT_PREFIX + event.sessionID) as string, next.id as never);
    } catch {
      // Tracking write is best-effort.
    }
    await recordAnnouncement(
      ctx,
      event.sessionID,
      buildAnnouncement({ oldModel: currentId, newModel: next.id, reason, mode }),
    );
  } catch {
    await recordAnnouncement(
      ctx,
      event.sessionID,
      buildAnnouncement({
        oldModel: currentId,
        reason,
        mode,
        suggestion: `Auto-switch to ${next.id} failed. Switch manually with /failover-use ${next.id}.`,
      }),
    );
  }
}

// Offline return: while failed over, re-evaluate expired remotes and move
// back when a remote is both available and strictly better than local.
// At most one auto-return per scope; an explicit user switch (pinned session)
// always wins and disables auto-return for that session.
async function maybeReturnFromOffline(
  ctx: Ctx,
  sessionID: string,
  scope: string,
): Promise<{ switched: boolean; text: string }> {
  const storage = ctx.storage;
  if (!storage) return { switched: false, text: "Storage unavailable; cannot re-evaluate remotes." };
  const returnedKey = RETURNED_PREFIX + scope;
  try {
    if ((await storage.get(returnedKey)) === true) {
      return { switched: false, text: "Already returned once this prompt; skipping further auto-returns." };
    }
  } catch {
    // Flag read failing means "not yet returned".
  }
  let pinned: unknown;
  try {
    pinned = await storage.get(PIN_PREFIX + sessionID);
  } catch {
    pinned = undefined;
  }
  if (typeof pinned === "string" && pinned.length > 0) {
    return {
      switched: false,
      text: `Session is pinned to ${pinned} by explicit user switch; auto-return disabled for this session.`,
    };
  }
  const mode = await getMode(storage, (ctx.options ?? {}) as { mode?: string }).catch(
    () => "auto" as FailoverMode,
  );
  if (mode !== "auto") {
    return { switched: false, text: "Mode is manual; not returning automatically. Use /failover-use <model>." };
  }
  let currentId: unknown;
  try {
    currentId = await storage.get(CURRENT_PREFIX + sessionID);
  } catch {
    currentId = undefined;
  }
  if (typeof currentId !== "string" || currentId.length === 0) {
    return { switched: false, text: "No failover state for this session; nothing to return from." };
  }
  const now = Date.now();
  const allowPaid = readAllowPaid(ctx.options);
  const exhausted = await readExhausted(storage, now);
  const candidates = await resolveCandidates(ctx, allowPaid);
  const local = candidates.find((c) => c.id === currentId && c.kind === "local");
  if (!local) {
    return { switched: false, text: "Current model is not a tracked local; nothing to return from." };
  }
  const remote = candidates.find((c) => c.kind !== "local" && !exhausted.has(c.id));
  if (!remote) {
    return { switched: false, text: "No remote has recovered yet; staying on local." };
  }
  // Caller-side bypass lives in /failover-use (pinned sessions return early
  // above); here the efficiency check always applies.
  if (!shouldReturnFromOffline(local, remote)) {
    return {
      switched: false,
      text: `Remote ${remote.id} is back but not strictly better than local ${local.id}; staying offline.`,
    };
  }
  if (typeof ctx.session?.switchModel !== "function") {
    const text = buildAnnouncement({
      oldModel: local.id,
      reason: `remote ${remote.id} recovered and is strictly better`,
      mode: "manual",
      suggestion: `Switch with /failover-use ${remote.id}.`,
    });
    await recordAnnouncement(ctx, sessionID, text);
    return { switched: false, text };
  }
  try {
    await ctx.session.switchModel({
      sessionID,
      model: { providerID: remote.providerID, id: remote.modelID },
    });
    try {
      await storage.set((CURRENT_PREFIX + sessionID) as string, remote.id as never);
      await storage.set(returnedKey as string, true as never);
    } catch {
      // Tracking writes are best-effort.
    }
    const text = buildAnnouncement({
      oldModel: local.id,
      newModel: remote.id,
      reason: "remote recovered and is strictly better than local",
      mode,
    });
    await recordAnnouncement(ctx, sessionID, text);
    return { switched: true, text };
  } catch {
    return { switched: false, text: `Return to ${remote.id} failed; staying on local ${local.id}.` };
  }
}

function commandText(input: { sessionID: string; prompt: { text?: unknown } }): string {
  return typeof input.prompt?.text === "string" ? input.prompt.text : "";
}

async function registerCommands(ctx: Ctx): Promise<void> {
  const transform = ctx.command?.transform;
  if (typeof transform !== "function" || !ctx.storage) return;
  const storage = ctx.storage;
  try {
    await transform((editor) => {
      editor.add({
        name: "failover-auto",
        description: "Switch model failover to automatic mode",
        execute: async (input) => {
          await setMode(storage, "auto");
          await recordAnnouncement(
            ctx,
            input.sessionID,
            "[model-failover:auto] Automatic switching enabled. Limits will trigger a switch with an announcement.",
          );
        },
      });
      editor.add({
        name: "failover-manual",
        description: "Switch model failover to manual-suggest mode",
        execute: async (input) => {
          await setMode(storage, "manual");
          await recordAnnouncement(
            ctx,
            input.sessionID,
            "[model-failover:manual] Manual mode enabled. Limits will suggest candidates instead of switching.",
          );
        },
      });
      editor.add({
        name: "failover-status",
        description: "Show failover mode, exhaustion, and last announcement",
        execute: async (input) => {
          const mode = await getMode(storage, {}).catch(() => "auto" as FailoverMode);
          const exhausted = await readExhausted(storage, Date.now());
          const last = await storage.get(LAST_PREFIX + input.sessionID).catch(() => undefined);
          const lines = [
            `[model-failover] mode: ${mode}`,
            `exhausted (${exhausted.size}): ${[...exhausted.keys()].join(", ") || "none"}`,
            `last: ${typeof last === "string" ? last : "none"}`,
          ];
          await recordAnnouncement(ctx, input.sessionID, lines.join("\n"));
        },
      });
      editor.add({
        name: "failover-use",
        description: "Explicitly switch to a model (pins the session, bypasses efficiency check)",
        execute: async (input) => {
          const ref = parseModelRef(commandText(input));
          if (!ref) {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              "Usage: /failover-use <provider/model>. This pins the session and disables auto-return until re-enabled.",
            );
            return;
          }
          const allowPaid = readAllowPaid(ctx.options);
          const candidates = await resolveCandidates(ctx, allowPaid);
          const target =
            candidates.find((c) => c.id === fullId(ref.providerID, ref.modelID)) ??
            (ref.providerID
              ? undefined
              : candidates.find((c) => c.modelID === ref.modelID));
          if (!target) {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              `Unknown model "${commandText(input).trim()}". Known: ${candidates.map((c) => c.id).join(", ") || "none configured"}.`,
            );
            return;
          }
          if (typeof ctx.session?.switchModel !== "function") {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              `Host cannot switch models; to use ${target.id}, switch manually in your client.`,
            );
            return;
          }
          try {
            await ctx.session.switchModel({
              sessionID: input.sessionID,
              model: { providerID: target.providerID, id: target.modelID },
            });
            try {
              await storage.set((PIN_PREFIX + input.sessionID) as string, target.id as never);
              await storage.set((CURRENT_PREFIX + input.sessionID) as string, target.id as never);
            } catch {
              // Tracking writes are best-effort.
            }
            const mode = await getMode(storage, {}).catch(() => "auto" as FailoverMode);
            await recordAnnouncement(
              ctx,
              input.sessionID,
              buildAnnouncement({
                oldModel: "previous model",
                newModel: target.id,
                reason: "explicit user request (session pinned; auto-return disabled)",
                mode,
              }),
            );
          } catch {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              `Switch to ${target.id} failed; staying on the current model.`,
            );
          }
        },
      });
      editor.add({
        name: "failover-recheck",
        description: "Re-evaluate recovered remotes and return from offline if one is strictly better",
        execute: async (input) => {
          const result = await maybeReturnFromOffline(ctx, input.sessionID, `recheck:${input.sessionID}:${Date.now()}`);
          await recordAnnouncement(ctx, input.sessionID, result.text);
        },
      });
      editor.add({
        name: "failover-setup",
        description: "Guided setup: Ollama binary, local model pull, provider wiring, keys (auto vs manual per component)",
        execute: async (input) => {
          // Stateless and re-runnable: every component offers automatic /
          // manual / skip. The merged config text is previewed, never
          // written, here (the caller handles backup + diff preview).
          const rawText = commandText(input).toLowerCase();
          const preference = rawText.includes("manual") ? "manual" : rawText.includes("auto") ? "auto" : "ask";
          try {
            const diag = await diagnoseHost();
            await recordAnnouncement(ctx, input.sessionID, buildSetupGuide(diag, { preference }));
          } catch {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              "[model-failover] setup: host diagnosis failed; preflight with `node scripts/check.mjs`, then say /failover-setup again (all steps skippable).",
            );
          }
        },
      });
      editor.add({
        name: "failover-update",
        description: "Re-check all four setup components (binary, models, providers, keys) and guide updates",
        execute: async (input) => {
          // Re-runnable report; nothing is applied without confirmation.
          try {
            const diag = await diagnoseHost();
            await recordAnnouncement(ctx, input.sessionID, buildUpdateReport(diag));
          } catch {
            await recordAnnouncement(
              ctx,
              input.sessionID,
              "[model-failover] update: host diagnosis failed; re-run `node scripts/check.mjs` and /failover-status manually.",
            );
          }
        },
      });
    });
  } catch {
    // Command registration failing must not break the plugin on old hosts.
  }
}

const plugin = Plugin.define({
  id: "model-failover",
  setup: async (raw: unknown) => {
    const ctx = raw as Ctx;
    // Init stored mode from plugin options (options win on startup).
    try {
      const startupMode = (ctx.options as Record<string, unknown> | undefined)?.["mode"];
      if ((startupMode === "auto" || startupMode === "manual") && ctx.storage) {
        await setMode(ctx.storage, startupMode);
      }
    } catch {
      // Mode init is best-effort.
    }

    await registerCommands(ctx);

    // Feature-detect the retry path. If the hook or switchModel is missing
    // (e.g. OpenCode 1.19.0), degrade to manual-suggest-only via commands.
    if (typeof ctx.session?.hook !== "function") return;
    try {
      await ctx.session.hook("retry", (event) => handleRetry(ctx, event as unknown as RetryEvent));
    } catch {
      // Retry hook unsupported on this host; commands still work.
      return;
    }
    const session = ctx.session;
    if (session && typeof session.hook === "function") {
      try {
        await session.hook("prompt", (event) => {
          const prompt = event as unknown as { sessionID: string; messageID?: string };
          if (!prompt || typeof prompt.sessionID !== "string") return;
          const scope = typeof prompt.messageID === "string" ? prompt.messageID : prompt.sessionID;
          return (async () => {
            try {
              await ctx.storage?.remove((HOPS_PREFIX + prompt.sessionID) as string);
            } catch {
              // Hop reset is best-effort.
            }
            const result = await maybeReturnFromOffline(ctx, prompt.sessionID, scope);
            if (result.switched) {
              await recordAnnouncement(ctx, prompt.sessionID, result.text);
            }
          })();
        });
      } catch {
        // Prompt hook unsupported; /failover-recheck still covers returns.
      }
    }
  },
});

export default plugin;
