/** Bounded-resource defaults. Existing query budgets stay unchanged. */

export interface JobBudgets {
  /** Maximum accepted response body per HTTP request (bytes). */
  maxResponseBytes: number;
  /** Maximum unique records retained for one task. */
  maxTaskRecords: number;
  /** Maximum terminal jobs kept for views/export history. */
  maxRetainedJobs: number;
}

export const DEFAULT_JOB_BUDGETS: JobBudgets = {
  maxResponseBytes: 8 * 1024 * 1024,
  maxTaskRecords: 50_000,
  maxRetainedJobs: 20,
};

export function resolveBudgets(overrides: Partial<JobBudgets> | undefined): JobBudgets {
  return { ...DEFAULT_JOB_BUDGETS, ...(overrides ?? {}) };
}
