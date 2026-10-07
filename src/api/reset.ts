// Reset. Node-only. Mirrored by src/git/reset.ts.

import { gitRun } from './exec';
import type { ResetMode } from '../types';

export const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'hard'];

/** Move HEAD (and the checked-out branch) to `ref`, discarding changes for hard. */
export async function resetBranch(repoPath: string, mode: ResetMode, ref: string): Promise<void> {
  await gitRun(repoPath, ['reset', `--${mode}`, ref]);
}
