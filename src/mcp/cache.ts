/** Completion-based TTL with one in-flight scan. Failed scans are never cached or returned as fresh. */
export class SnapshotCache<T> {
  private cached: { value: T; completedAt: number } | undefined;
  private pending: Promise<{ value: T; completedAt: number }> | undefined;
  private readonly loader: () => Promise<T>;
  readonly ttlMilliseconds: number;
  private readonly now: () => number;

  constructor(loader: () => Promise<T>, ttlMilliseconds: number, now = Date.now) {
    if (!Number.isFinite(ttlMilliseconds) || ttlMilliseconds < 0) throw new Error("Invalid cache TTL.");
    this.loader = loader; this.ttlMilliseconds = ttlMilliseconds; this.now = now;
  }

  async get(): Promise<{ value: T; completedAt: number }> {
    if (this.cached && this.now() - this.cached.completedAt < this.ttlMilliseconds) return this.cached;
    if (!this.pending) {
      this.pending = Promise.resolve().then(this.loader).then((value) => {
        this.cached = { value, completedAt: this.now() };
        return this.cached;
      }).finally(() => { this.pending = undefined; });
    }
    return await this.pending;
  }
}
