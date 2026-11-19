import { AsyncLocalStorage } from "node:async_hooks";

export type AiExecutionMode = "real" | "mock";
export type AiExecutionProfile = {
  mode: AiExecutionMode;
  provider?: string; model?: string; embeddingProvider?: string; embeddingModel?: string;
  syntheticDemo?: boolean;
  instagramTestClientId?: string;
  retrievalMode?: "local_text";
};
const execution = new AsyncLocalStorage<AiExecutionProfile>();

// Per-job scope: never mutate process-wide AI settings in a shared worker.
export function withAiExecutionMode<T>(mode: AiExecutionMode, run: () => T): T {
  return execution.run({ mode }, run);
}
export function aiExecutionMode(): AiExecutionMode | undefined {
  return execution.getStore()?.mode;
}
export function withAiExecutionProfile<T>(profile: AiExecutionProfile, run: () => T): T {
  return execution.run(Object.freeze({ ...profile }), run);
}
export function aiExecutionProfile(): Readonly<AiExecutionProfile> | undefined { return execution.getStore(); }
