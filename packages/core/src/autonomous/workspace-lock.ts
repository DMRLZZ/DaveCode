/**
 * In-process mutual exclusion over one repository's working tree. The autonomous runner and goal
 * mode both check out branches and commit, so only one owner may drive the tree at a time. The
 * lock is re-entrant per owner: goal mode holds it as `goal` for the whole run and the runners it
 * creates for code tasks acquire it under the same owner.
 */
export class WorkspaceLock {
  private owner: string | undefined;
  private depth = 0;

  /** Current owner, if any. */
  get holder(): string | undefined {
    return this.owner;
  }

  /** Takes the lock for `owner`. Returns false when another owner holds it. */
  acquire(owner: string): boolean {
    if (this.owner !== undefined && this.owner !== owner) return false;
    this.owner = owner;
    this.depth++;
    return true;
  }

  /** Releases one acquisition by `owner`; a no-op for anyone else. */
  release(owner: string): void {
    if (this.owner !== owner) return;
    this.depth--;
    if (this.depth <= 0) {
      this.depth = 0;
      this.owner = undefined;
    }
  }
}
