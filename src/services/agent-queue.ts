export const agentConcurrency = 5;

/** A single pool for foreground, background and continuation executions. */
export class AgentQueue {
  readonly #shutdown = new AbortController();
  readonly #waiting: { start(): void; cancel(): void }[] = [];
  readonly #active = new Set<Promise<void>>();
  #running = 0;
  constructor(private readonly limit = agentConcurrency) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("并发名额必须为正整数。");
  }
  run<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const cancel = AbortSignal.any([signal, this.#shutdown.signal]);
    if (cancel.aborted) return Promise.reject(cancel.reason);
    return new Promise<T>((resolve, reject) => {
      const item = {
        cancel: () => {
          const index = this.#waiting.indexOf(item);
          if (index < 0) return;
          this.#waiting.splice(index, 1);
          cancel.removeEventListener("abort", item.cancel);
          reject(cancel.reason);
        },
        start: () => {
          cancel.removeEventListener("abort", item.cancel);
          this.#running++;
          const active = Promise.resolve().then(() => {
            cancel.throwIfAborted();
            return work(cancel);
          }).then(resolve, reject).finally(() => {
            this.#running--;
            this.#active.delete(active);
            this.drain();
          });
          this.#active.add(active);
        },
      };
      this.#waiting.push(item);
      cancel.addEventListener("abort", item.cancel, { once: true });
      this.drain();
    });
  }
  private drain() {
    while (!this.#shutdown.signal.aborted && this.#running < this.limit && this.#waiting.length) {
      this.#waiting.shift()!.start();
    }
  }
  async close() {
    this.#shutdown.abort();
    await Promise.allSettled([...this.#active]);
  }
}
