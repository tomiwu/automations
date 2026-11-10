// The preflight doctor gate: no agent starts when the doctor fails.

export type RunDoctor = () => number;

/** True when the doctor passed or the start script ran it already (`LOOP_DOCTOR_DONE=1`). */
export function preflight(run: RunDoctor, done: boolean, log: (message: string) => void): boolean {
  if (done) return true;
  const status = run();
  if (status === 0) return true;
  log(`DOCTOR FAIL (exit ${status}). No agent starts.`);
  return false;
}
