import { describe, expect, it } from "vitest";
import plugin, { buildAnnouncement } from "../src/index.js";

// Persistent regression net for the plugin shell (Task 2 fix round 1/5).
// Stubs ctx (hook capture, switchModel spy, in-memory storage, command
// capture, no live model.list) and drives the real handlers. Vitest only.

function memStorage(seed: Record<string, unknown> = {}) {
  const mem = new Map<string, unknown>(Object.entries(seed));
  return {
    mem,
    get: async (k: string) => mem.get(k),
    set: async (k: string, v: never) => { mem.set(k, v); },
    remove: async (k: string) => { mem.delete(k); },
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...mem.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  };
}

type StorageStub = ReturnType<typeof memStorage>;

function makeCtx(storage: StorageStub, options: Record<string, unknown> = {}) {
  const hooks = new Map<string, (e: never) => unknown>();
  const commands: { name: string; execute: (i: never) => Promise<void> }[] = [];
  const switches: { sessionID: string; model: { providerID: string; id: string } }[] = [];
  const ctx = {
    options,
    storage,
    session: {
      hook: async (name: string, cb: (e: never) => unknown) => {
        hooks.set(name, cb);
        return { dispose: async () => {} };
      },
      switchModel: async (input: { sessionID: string; model: { providerID: string; id: string } }) => {
        switches.push(input);
      },
    },
    command: {
      transform: async (cb: (e: { add: (d: never) => void }) => void) => {
        cb({ add: (d: never) => commands.push(d as never) });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, hooks, commands, switches };
}

async function setup(ctx: unknown): Promise<void> {
  await (plugin.setup as (c: unknown) => Promise<void>)(ctx);
}

function retryEvent(sessionID: string, providerID: string, id: string, error: unknown): never {
  return { sessionID, model: { providerID, id }, error } as never;
}

const BASE_MODELS = [
  { providerID: "a", modelID: "m1" },
  { providerID: "b", modelID: "m2" },
  { providerID: "ollama", modelID: "q7b", kind: "local" },
];

describe("shell: retry hook", () => {
  it("(1) auto retry on 429 switches via pickNext, records exhaustion + announcement", async () => {
    const storage = memStorage();
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "auto", models: BASE_MODELS });
    await setup(ctx as unknown);
    const event = retryEvent("s1", "a", "m1", {
      type: "provider.rate-limited",
      message: "rate limited",
      status: 429,
    }) as unknown as { decision: unknown };
    await (hooks.get("retry") as (e: never) => Promise<void>)(event as never);
    expect(event.decision).toEqual({ retry: false });
    expect(typeof storage.mem.get("failover:exhausted:a/m1")).toBe("number");
    expect(switches).toEqual([{ sessionID: "s1", model: { providerID: "b", id: "m2" } }]);
    const last = String(storage.mem.get("failover:last:s1"));
    expect(last).toContain("a/m1");
    expect(last).toContain("b/m2");
  });

  it("(2) manual mode does NOT switchModel but announces a suggestion", async () => {
    const storage = memStorage();
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "manual", models: BASE_MODELS });
    await setup(ctx as unknown);
    const event = retryEvent("s1", "a", "m1", { message: "quota exceeded", status: 400 }) as unknown as {
      decision: unknown;
    };
    await (hooks.get("retry") as (e: never) => Promise<void>)(event as never);
    expect(event.decision).toEqual({ retry: false });
    expect(switches).toEqual([]);
    expect(String(storage.mem.get("failover:last:s1"))).toContain("/failover-use b/m2");
  });

  it("(3) hop cap: 4th limit error in the same prompt performs no switch", async () => {
    const models = [
      { providerID: "a", modelID: "m1" },
      { providerID: "b", modelID: "m2" },
      { providerID: "c", modelID: "m3" },
      { providerID: "d", modelID: "m4" },
      { providerID: "e", modelID: "m5" },
      { providerID: "ollama", modelID: "q7b", kind: "local" },
    ];
    const storage = memStorage();
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "auto", models });
    await setup(ctx as unknown);
    const fire = (providerID: string, id: string) =>
      (hooks.get("retry") as (e: never) => Promise<void>)(
        retryEvent("s1", providerID, id, { message: "rate limited", status: 429 }),
      );
    await fire("a", "m1"); // hop 1 -> b/m2
    await fire("b", "m2"); // hop 2 -> c/m3
    await fire("c", "m3"); // hop 3 -> d/m4
    expect(switches.map((s) => `${s.model.providerID}/${s.model.id}`)).toEqual(["b/m2", "c/m3", "d/m4"]);
    await fire("d", "m4"); // 4th: capped, no switch even though e/m5 is alive
    expect(switches.length).toBe(3);
    expect(String(storage.mem.get("failover:last:s1"))).toContain("3 failover hops");
  });

  it("ignores non-limit errors (leaves default retry alone)", async () => {
    const storage = memStorage();
    const { ctx, hooks, switches } = makeCtx(storage, { models: BASE_MODELS });
    await setup(ctx as unknown);
    const event = retryEvent("s1", "a", "m1", { message: "boom", status: 500 }) as unknown as {
      decision: unknown;
    };
    await (hooks.get("retry") as (e: never) => Promise<void>)(event as never);
    expect(event.decision).toBeUndefined();
    expect(switches).toEqual([]);
  });
});

describe("shell: offline return", () => {
  it("(4a) weak remote back -> stays local", async () => {
    const models = [
      { providerID: "a", modelID: "weak", kind: "free", tools: false, context: 8000 },
      { providerID: "ollama", modelID: "q7b", kind: "local", tools: true, context: 32768 },
    ];
    const storage = memStorage({ "failover:current:s1": "ollama/q7b" });
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "auto", models });
    await setup(ctx as unknown);
    await (hooks.get("prompt") as (e: never) => Promise<void>)(
      { sessionID: "s1", messageID: "m-1", prompt: { text: "hi" } } as never,
    );
    expect(switches).toEqual([]);
  });

  it("(4b) strong remote back -> switches, at most once per scope", async () => {
    const models = [
      { providerID: "b", modelID: "strong", kind: "free", tools: true, context: 128000 },
      { providerID: "ollama", modelID: "q7b", kind: "local", tools: true, context: 32768 },
    ];
    const storage = memStorage({ "failover:current:s1": "ollama/q7b" });
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "auto", models });
    await setup(ctx as unknown);
    const firePrompt = () =>
      (hooks.get("prompt") as (e: never) => Promise<void>)(
        { sessionID: "s1", messageID: "m-1", prompt: { text: "hi" } } as never,
      );
    await firePrompt();
    expect(switches).toEqual([{ sessionID: "s1", model: { providerID: "b", id: "strong" } }]);
    await firePrompt(); // same scope: no second return
    expect(switches.length).toBe(1);
  });
});

describe("shell: commands", () => {
  it("(5) /failover-use pins the session; subsequent auto-return is skipped", async () => {
    const storage = memStorage();
    const { ctx, hooks, commands, switches } = makeCtx(storage, { models: BASE_MODELS });
    await setup(ctx as unknown);
    expect(commands.map((c) => c.name).sort()).toEqual([
      "failover-auto",
      "failover-manual",
      "failover-recheck",
      "failover-setup",
      "failover-status",
      "failover-update",
      "failover-use",
    ]);
    const use = commands.find((c) => c.name === "failover-use")!;
    await use.execute({ sessionID: "s1", prompt: { text: "/failover-use b/m2" } } as never);
    expect(switches.length).toBe(1);
    expect(storage.mem.get("failover:pinned:s1")).toBe("b/m2");
    // Failed over to local afterwards, but the pin wins over auto-return.
    storage.mem.set("failover:current:s1", "ollama/q7b");
    await (hooks.get("prompt") as (e: never) => Promise<void>)(
      { sessionID: "s1", messageID: "m-9", prompt: { text: "hi" } } as never,
    );
    expect(switches.length).toBe(1);
  });

  it("manual mode skips auto-return; announce helper always carries mode + flip hint", async () => {
    const storage = memStorage({ "failover:current:s1": "ollama/q7b" });
    const { ctx, hooks, switches } = makeCtx(storage, { mode: "manual", models: BASE_MODELS });
    await setup(ctx as unknown);
    await (hooks.get("prompt") as (e: never) => Promise<void>)(
      { sessionID: "s1", messageID: "m-1", prompt: { text: "hi" } } as never,
    );
    expect(switches).toEqual([]);
    const auto = buildAnnouncement({ oldModel: "x", newModel: "y", reason: "r", mode: "auto" });
    const manual = buildAnnouncement({ oldModel: "x", reason: "r", mode: "manual", exhaustedAll: true });
    expect(auto).toContain("auto");
    expect(auto).toContain("/failover-manual");
    expect(manual).toContain("manual");
    expect(manual).toContain("/failover-auto");
  });

  it("(6) /failover-setup + /failover-update registered; setup announces host + auto/manual steps", async () => {
    const storage = memStorage();
    const { ctx, commands } = makeCtx(storage, { models: BASE_MODELS });
    await setup(ctx as unknown);
    const names = commands.map((c) => c.name);
    expect(names).toContain("failover-setup");
    expect(names).toContain("failover-update");
    const setupCmd = commands.find((c) => c.name === "failover-setup")!;
    await setupCmd.execute({ sessionID: "s1", prompt: { text: "/failover-setup" } } as never);
    const last = String(storage.mem.get("failover:last:s1"));
    expect(last).toContain("Ollama");
    expect(last).toContain("automatic");
    const updateCmd = commands.find((c) => c.name === "failover-update")!;
    await updateCmd.execute({ sessionID: "s1", prompt: { text: "/failover-update" } } as never);
    expect(String(storage.mem.get("failover:last:s1"))).toContain("update");
  });
});
