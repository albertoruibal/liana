// Repository validation for POST /open. Node-only.

import fs from 'node:fs';
import path from 'node:path';
import { gitRun } from './exec';

export async function resolveOpenRepo(raw: string): Promise<string | null> {
  if (!raw.trim()) return null;
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : raw;
  const abs = path.resolve(expanded);
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    await gitRun(abs, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  return abs;
}
