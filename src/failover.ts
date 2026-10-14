export type Candidate = {
  id: string;
  providerID: string;
  modelID: string;
  kind: "free" | "custom" | "paid" | "local";
  tools?: boolean;
  context?: number;
};

const LIMIT_RE =
  /quota|rate.?limit|usage.?limit|5.?hour|monthly|tokens? per|exhausted|overloaded with limit|invalid-request.*(quota|limit)/i;

export function isLimitError(input: { status?: number; message?: string; code?: string }): boolean {
  if (input.status === 429) return true;
  const haystack = [input.code ?? "", input.message ?? ""].join(" ");
  return LIMIT_RE.test(haystack);
}

const FIVE_MIN = 5 * 60 * 1000;
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function cooldownMsFor(input: { status?: number; message?: string }): number {
  const message = input.message ?? "";
  if (/5.?hour/i.test(message)) return FIVE_HOURS;
  if (/monthly/i.test(message)) return THIRTY_DAYS;
  return FIVE_MIN;
}

const KIND_RANK: Record<Candidate["kind"], number> = {
  free: 0,
  custom: 1,
  paid: 2,
  local: 3,
};

export function pickNext(
  candidates: Candidate[],
  exhausted: Map<string, number>,
  opts: { allowPaid: string[]; now: number },
): Candidate | undefined {
  const alive = candidates.filter((c) => {
    const until = exhausted.get(c.id);
    if (until !== undefined && until > opts.now) return false;
    if (c.kind === "paid") {
      const optedIn =
        opts.allowPaid.includes(c.id) ||
        opts.allowPaid.includes(c.providerID) ||
        opts.allowPaid.includes(c.modelID);
      if (!optedIn) return false;
    }
    return true;
  });
  alive.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  return alive[0];
}

export function shouldReturnFromOffline(
  _local: Candidate,
  remote: Candidate | undefined,
): boolean {
  if (remote === undefined) return false;
  // Efficiency rule: stay local while only a low-tier remote is back.
  // (The "user explicitly requested remote" escape hatch lives with the
  // caller, which bypasses this check in that case.)
  if (remote.tools === false) return false;
  if (remote.context !== undefined && remote.context < 32000) return false;
  return true;
}
