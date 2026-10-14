import { describe, expect, it } from "vitest";
import { getMode, setMode } from "../src/mode.js";
describe("mode", () => {
  it("persists auto/manual across reads", async () => {
    const mem = new Map<string, unknown>();
    const storage = { get: async (k: string) => mem.get(k) as never, set: async (k: string, v: never) => { mem.set(k, v); }, remove: async (k: string) => { mem.delete(k); }, scan: async () => ({ entries: [] }) };
    await setMode(storage as never, "manual");
    expect(await getMode(storage as never, {})).toBe("manual");
    expect(mem.get("failover:mode")).toBe("manual");
  });
  it("stored mode wins over options (options only seed storage at setup)", async () => {
    const mem = new Map<string, unknown>([["failover:mode", "manual"]]);
    const storage = { get: async (k: string) => mem.get(k) as never, set: async (k: string, v: never) => { mem.set(k, v); }, remove: async (k: string) => { mem.delete(k); }, scan: async () => ({ entries: [] }) };
    expect(await getMode(storage as never, { mode: "auto" })).toBe("manual");
  });
  it("options apply only when nothing is stored yet", async () => {
    const mem = new Map<string, unknown>();
    const storage = { get: async (k: string) => mem.get(k) as never, set: async (k: string, v: never) => { mem.set(k, v); }, remove: async (k: string) => { mem.delete(k); }, scan: async () => ({ entries: [] }) };
    expect(await getMode(storage as never, { mode: "manual" })).toBe("manual");
    expect(await getMode(storage as never, {})).toBe("auto");
  });
});
