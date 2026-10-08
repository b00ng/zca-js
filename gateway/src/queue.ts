import { HttpError } from "./errors.js";

type Job<T> = {
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
};

/**
 * Serial send queue: Zalo flags accounts that blast messages, so every outgoing message goes
 * through one queue with a minimum gap (plus random jitter) between sends.
 */
export class SendQueue {
    private jobs: Job<unknown>[] = [];
    private running = false;
    private lastSentAt = 0;

    constructor(
        private options: { minIntervalMs: number; jitterMs: number; maxQueueSize: number; timeoutMs: number },
    ) {}

    get size() {
        return this.jobs.length + (this.running ? 1 : 0);
    }

    push<T>(run: () => Promise<T>): Promise<T> {
        if (this.jobs.length >= this.options.maxQueueSize) {
            return Promise.reject(
                new HttpError(429, "QUEUE_FULL", `Send queue is full (${this.options.maxQueueSize}), retry later`),
            );
        }
        return new Promise<T>((resolve, reject) => {
            this.jobs.push({ run, resolve, reject } as Job<unknown>);
            void this.drain();
        });
    }

    private async drain() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.jobs.length > 0) {
                const job = this.jobs.shift()!;
                const gap = this.options.minIntervalMs + Math.random() * this.options.jitterMs;
                const wait = this.lastSentAt + gap - Date.now();
                if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

                try {
                    job.resolve(await withTimeout(job.run(), this.options.timeoutMs));
                } catch (error) {
                    job.reject(error);
                } finally {
                    this.lastSentAt = Date.now();
                }
            }
        } finally {
            this.running = false;
        }
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return promise;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HttpError(504, "SEND_TIMEOUT", `Zalo did not answer within ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
