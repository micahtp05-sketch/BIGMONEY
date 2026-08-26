import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace } from './types.ts';

const EMPTY: Workspace = { version: 1, businesses: [], ideas: [] };

export function workspacePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKSPACE_FILE ?? fileURLToPath(new URL('../../data/workspace.json', import.meta.url));
}

/**
 * The whole workspace in one JSON file: read once at boot, held in memory,
 * rewritten on every change.
 *
 * A single-file document is the right size for this — one owner, a few
 * businesses, a few hundred rows of monthly figures — and it keeps the data
 * legible and portable. Two properties make it safe anyway: writes are
 * serialised through a queue so concurrent requests can't interleave, and each
 * write lands in a temp file that is renamed over the real one, so a crash
 * mid-write leaves the previous good document intact rather than a truncated
 * file.
 */
export class WorkspaceStore {
  readonly path: string;
  #data: Workspace;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, data: Workspace) {
    this.path = path;
    this.#data = data;
  }

  static async open(path = workspacePathFromEnv()): Promise<WorkspaceStore> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new WorkspaceStore(path, structuredClone(EMPTY));
      }
      throw error;
    }

    let parsed: Workspace;
    try {
      parsed = JSON.parse(raw) as Workspace;
    } catch {
      // Refusing to start beats starting empty and overwriting the file on the
      // first write — that would turn a recoverable typo into data loss.
      throw new Error(`Workspace file at ${path} is not valid JSON. Fix or move it, then restart.`);
    }
    if (parsed.version !== 1) {
      throw new Error(`Workspace file at ${path} has unsupported version ${parsed.version}.`);
    }
    return new WorkspaceStore(path, { ...structuredClone(EMPTY), ...parsed });
  }

  /** The live document. Read freely; never mutate outside `mutate()`. */
  read(): Workspace {
    return this.#data;
  }

  /**
   * Apply a change and persist it. The callback runs against the live
   * document; whatever it returns is handed back once the write lands, so
   * handlers can build a response from the state they just created.
   */
  async mutate<T>(fn: (workspace: Workspace) => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const result = fn(this.#data);
      await this.#persist();
      return result;
    });
    // Keep the chain alive even when this caller's mutation throws, otherwise
    // one bad request would wedge every write after it.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }
}
