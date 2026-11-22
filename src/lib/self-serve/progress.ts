export type SourceProgress = {
  stage: string;
  completed: number | null;
  total: number | null;
  retryAt: string | null;
  jobStatus: string | null;
};
type Counts = { phase?: string; cursor?: unknown; segments?: unknown;
  verifyCursor?: unknown; rules?: unknown; judgeCursor?: unknown; pairs?: unknown };
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function sourceProgress(input: {
  status: string; job_status: string | null; attempts: number | null;
  available_at: Date | string | null; processing_counts: Counts | null;
}, now = Date.now()): SourceProgress {
  const base: SourceProgress = { stage: "Processing status unavailable", completed: null,
    total: null, retryAt: null, jobStatus: input.job_status };
  if (input.status === "ready") return { ...base, stage: "Source checked" };
  if (input.status === "failed") return { ...base, stage: "Processing stopped" };
  if (!input.job_status || !["pending", "processing"].includes(input.job_status)) return base;
  const data = input.processing_counts;
  const phases: Record<string, [string, unknown, unknown]> = {
    extract: ["Extracting business rules", data?.cursor, data?.segments],
    verify: ["Checking source accuracy", data?.verifyCursor, data?.rules],
    judge: ["Checking rule conflicts", data?.judgeCursor, data?.pairs],
  };
  const phase = data?.phase && Object.prototype.hasOwnProperty.call(phases, data.phase) ? phases[data.phase] : undefined;
  const total = count(phase?.[2]), completed = count(phase?.[1] ?? 0);
  const waiting = input.job_status === "pending" && (input.attempts ?? 0) > 0 && input.available_at
    ? new Date(input.available_at).getTime() : NaN;
  return { ...base,
    stage: Number.isFinite(waiting) && waiting > now ? "Waiting to retry" :
      data?.phase === "judge" && total !== null && completed === total ? "Finalising checked rules" :
      phase?.[0] ?? (input.job_status === "pending" ? "Queued to read source" : "Reading source"),
    completed: completed !== null && total !== null ? Math.min(completed, total) : null,
    total,
    retryAt: Number.isFinite(waiting) && waiting > now ? new Date(waiting).toISOString() : null,
  };
}
