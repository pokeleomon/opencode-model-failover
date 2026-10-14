// Persisted auto/manual toggle for model failover.
// Storage key: "failover:mode". Default: "auto".

export type FailoverMode = "auto" | "manual";

// Minimal structural storage type so tests can pass an in-memory stub
// without importing @opencode/plugin types.
export type Storage = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: never) => Promise<void>;
  remove: (key: string) => Promise<void>;
  scan: (options: { prefix: string }) => Promise<{ entries: readonly { key: string; value: unknown }[] }>;
};

export const MODE_KEY = "failover:mode";

function isMode(value: unknown): value is FailoverMode {
  return value === "auto" || value === "manual";
}

export async function getMode(
  storage: Storage,
  options: { mode?: string },
): Promise<FailoverMode> {
  if (isMode(options.mode)) return options.mode;
  const stored = await storage.get(MODE_KEY);
  if (isMode(stored)) return stored;
  return "auto";
}

export async function setMode(storage: Storage, mode: FailoverMode): Promise<void> {
  await storage.set(MODE_KEY, mode as never);
}
