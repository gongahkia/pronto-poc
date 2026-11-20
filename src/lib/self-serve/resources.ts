// Upload parsing, encryption and document processing share one memory-heavy
// slot per process. PostgreSQL leases separately serialize workspace jobs.
const state = globalThis as typeof globalThis & {
  prontoSelfServeWork?: symbol;
};
export function trySelfServeWork(): (() => void) | null {
  if (state.prontoSelfServeWork) return null;
  const token = Symbol("selfserve-work");
  state.prontoSelfServeWork = token;
  return () => {
    if (state.prontoSelfServeWork === token) delete state.prontoSelfServeWork;
  };
}
