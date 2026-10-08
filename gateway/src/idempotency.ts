const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

type Entry = { expiresAt: number; result: Promise<unknown> };

/**
 * In-memory idempotency cache (24h). A retried request with the same Idempotency-Key gets the
 * original result instead of sending the message twice. Lost on restart.
 */
export class IdempotencyCache {
    private entries = new Map<string, Entry>();

    run<T>(key: string | undefined, fn: () => Promise<T>): { result: Promise<T>; replayed: boolean } {
        if (!key) return { result: fn(), replayed: false };

        const now = Date.now();
        const existing = this.entries.get(key);
        if (existing && existing.expiresAt > now) return { result: existing.result as Promise<T>, replayed: true };

        const result = fn();
        this.entries.set(key, { expiresAt: now + TTL_MS, result });
        // failed sends may be retried with the same key
        result.catch(() => this.entries.delete(key));
        this.evict(now);
        return { result, replayed: false };
    }

    private evict(now: number) {
        if (this.entries.size <= MAX_ENTRIES) return;
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now || this.entries.size > MAX_ENTRIES) this.entries.delete(key);
            else break;
        }
    }
}
