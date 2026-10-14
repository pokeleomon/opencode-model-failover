import { describe, expect, it } from "vitest";
import { isLimitError, pickNext, shouldReturnFromOffline } from "../src/failover.js";
describe("isLimitError", () => {
  it("flags 429 and quota/5-hour/monthly strings", () => {
    expect(isLimitError({ status: 429, message: "rate limited" })).toBe(true);
    expect(isLimitError({ status: 400, message: "monthly limit exceeded" })).toBe(true);
    expect(isLimitError({ status: 500, message: "boom" })).toBe(false);
  });
  it("flags HTML/nginx 429 bodies and 400 invalid-request limit messages", () => {
    expect(isLimitError({ status: 429, message: "<html>429 Too Many Requests</html>" })).toBe(true);
    expect(isLimitError({ status: 400, code: "provider.invalid-request", message: "quota exceeded for free tier" })).toBe(true);
  });
});
describe("pickNext", () => {
  it("skips exhausted + paid without opt-in, prefers free then local", () => {
    const c = [
      { id: "a/m1", providerID: "a", modelID: "m1", kind: "free" as const },
      { id: "openai/gpt-x", providerID: "openai", modelID: "gpt-x", kind: "paid" as const },
      { id: "ollama/qwen2.5-coder:7b", providerID: "ollama", modelID: "qwen2.5-coder:7b", kind: "local" as const },
    ];
    const got = pickNext(c, new Map([["a/m1", Date.now() + 60_000]]), { allowPaid: [], now: Date.now() });
    expect(got?.id).toBe("ollama/qwen2.5-coder:7b");
  });
});
describe("shouldReturnFromOffline", () => {
  it("stays local when only a weak remote is back, returns when remote is strictly better", () => {
    const local = { id: "ollama/q7b", providerID: "ollama", modelID: "q7b", kind: "local" as const, tools: true, context: 32768 };
    const weak = { id: "a/weak", providerID: "a", modelID: "weak", kind: "free" as const, tools: false, context: 8000 };
    const strong = { id: "b/strong", providerID: "b", modelID: "strong", kind: "free" as const, tools: true, context: 128000 };
    expect(shouldReturnFromOffline(local, weak)).toBe(false);
    expect(shouldReturnFromOffline(local, strong)).toBe(true);
    expect(shouldReturnFromOffline(local, undefined)).toBe(false);
  });
});
