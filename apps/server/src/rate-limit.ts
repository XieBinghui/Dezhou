type WindowStat = { count: number; resetAt: number };

export class SlidingWindowLimiter {
  private readonly stats = new Map<string, WindowStat>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  take(key: string, now = Date.now()): boolean {
    const current = this.stats.get(key);
    if (!current || current.resetAt <= now) {
      this.stats.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.max) {
      return false;
    }
    current.count += 1;
    return true;
  }
}
