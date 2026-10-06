import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { globalPaths } from '../paths';
import { atomicWriteFile, isNodeError, readFileIfExists } from './fs-util';

export class InvalidNoteNameError extends Error {
  constructor(
    readonly noteName: string,
    reason: string,
  ) {
    super(`Invalid brain note name ${JSON.stringify(noteName)}: ${reason}`);
    this.name = 'InvalidNoteNameError';
  }
}

export interface NoteInfo {
  /** Note name without the `.md` extension. */
  name: string;
  bytes: number;
  /** ISO timestamp of the last modification. */
  updatedAt: string;
}

const MAX_NAME_LENGTH = 100;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validates a note name and returns its canonical form (no `.md` suffix). Notes are flat files:
 * separators, `..`, leading dots, control characters and reserved device names are rejected.
 */
export function sanitizeNoteName(raw: string): string {
  const name = raw.trim().replace(/\.md$/i, '');
  if (name === '') throw new InvalidNoteNameError(raw, 'name is empty');
  if (name.length > MAX_NAME_LENGTH) throw new InvalidNoteNameError(raw, 'name is too long');
  if (/[\\/]/.test(name)) throw new InvalidNoteNameError(raw, 'path separators are not allowed');
  if (name.includes('..')) throw new InvalidNoteNameError(raw, '".." is not allowed');
  if (!SAFE_NAME.test(name)) {
    throw new InvalidNoteNameError(
      raw,
      'use letters, digits, spaces, "-", "_" and "." (not at the start)',
    );
  }
  if (/[. ]$/.test(name)) throw new InvalidNoteNameError(raw, 'must not end with "." or a space');
  if (WINDOWS_RESERVED.test(name.split('.')[0] ?? '')) {
    throw new InvalidNoteNameError(raw, 'reserved device name');
  }
  return name;
}

/** The user's global brain: markdown notes in `~/.davecode/brain/` (preferences, patterns). */
export class GlobalBrain {
  constructor(readonly dir: string = globalPaths().brain) {}

  private fileFor(name: string): string {
    return join(this.dir, `${sanitizeNoteName(name)}.md`);
  }

  /** All notes, sorted by name. Returns an empty list when the directory does not exist. */
  async list(): Promise<NoteInfo[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, 'ENOENT')) return [];
      throw err;
    }
    const notes: NoteInfo[] = [];
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      let name: string;
      try {
        name = sanitizeNoteName(entry);
      } catch {
        continue; // foreign file with a name we would never write; ignore it
      }
      const info = await stat(join(this.dir, entry));
      if (!info.isFile()) continue;
      notes.push({ name, bytes: info.size, updatedAt: info.mtime.toISOString() });
    }
    return notes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Note content, or `undefined` when it does not exist. */
  async read(name: string): Promise<string | undefined> {
    return readFileIfExists(this.fileFor(name));
  }

  async write(name: string, content: string): Promise<void> {
    await atomicWriteFile(this.fileFor(name), content);
  }

  /** Deletes a note. Returns false when it did not exist. */
  async delete(name: string): Promise<boolean> {
    const file = this.fileFor(name);
    try {
      await stat(file);
    } catch (err) {
      if (isNodeError(err, 'ENOENT')) return false;
      throw err;
    }
    await rm(file, { force: true });
    return true;
  }

  /** Every non-empty note concatenated under a `## <name>` heading, sorted by name. */
  async compose(): Promise<string> {
    const parts: string[] = [];
    for (const { name } of await this.list()) {
      const content = (await this.read(name))?.trim();
      if (content) parts.push(`## ${name}\n\n${content}`);
    }
    return parts.join('\n\n');
  }
}
