import type { TaskRow } from './model.js';

export type TaskStepOutcome = 'recorded' | 'deferred' | 'stale' | 'retry_scheduled' | 'reconciling';

export interface Attempt {
  task: TaskRow;
  owner: string;
  version: number;
  attempt: number;
  signal?: AbortSignal;
  stepOutcome?: TaskStepOutcome;
}

export interface TaskExecutor {
  execute(attempt: Attempt): Promise<{ digest: string; bytes: number }>;
}

export interface ExternalTaskExecutor {
  execute(attempt: Attempt): Promise<boolean>;
  fail?(attempt: Attempt, code: string, retryable: boolean): Promise<boolean>;
}
