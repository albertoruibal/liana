// Browser-side mirror of src/api/reset.ts: reset.

import { git } from './exec';
import type { ResetMode } from '../types';

export const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard'];

/** Move HEAD (and the checked-out branch) to `ref`, discarding changes for hard. */
export async function resetBranch(repoPath: string, mode: ResetMode, ref: string): Promise<void> {
  await git(repoPath, ['reset', `--${mode}`, ref]);
}
