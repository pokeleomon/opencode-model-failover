import { describe, expect, it } from "vitest";
import { mergeOllamaConfig } from "../src/setup.js";
describe("mergeOllamaConfig", () => {
  it("preserves comments and unrelated providers", () => {
    const input = `{\n// user comment\n"providers": { "openai": { "name": "x" } }\n}`;
    const out = mergeOllamaConfig(input, "qwen2.5-coder:7b");
    expect(out).toContain("// user comment");
    expect(out).toContain('"openai"');
    expect(out).toContain('"ollama"');
    expect(out).not.toContain("sk-");
  });
  it("does not clobber existing ollama models", () => {
    const input = `{"providers": {"ollama": {"name": "O", "models": {"m1": {"name": "M1"}}}}}`;
    const out = mergeOllamaConfig(input, "qwen2.5-coder:7b");
    expect(out).toContain('"m1"');
    expect(out).toContain("qwen2.5-coder:7b");
  });
});
