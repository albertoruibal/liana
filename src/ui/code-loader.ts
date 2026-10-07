// On-demand Monaco loader. The editor and its language workers stay out of the
// initial bundle; the first code view triggers the import. `null` means
// "tried and unavailable".

type CodeModule = typeof import('../code');
let codeModule: CodeModule | null | undefined;

export async function loadCode(): Promise<CodeModule | null> {
  if (codeModule !== undefined) return codeModule;
  try {
    codeModule = await import('../code');
  } catch {
    codeModule = null;
  }
  return codeModule;
}

/** The already-loaded Monaco module, or undefined when never requested. */
export function loadedCode(): CodeModule | null | undefined {
  return codeModule;
}
