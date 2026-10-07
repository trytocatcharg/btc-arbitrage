/**
 * Serial in-process execution queue for trade-execution jobs.
 *
 * Trade execution (limit entry fill wait + hedge + TP/SL) takes 30–45 s
 * typical and ~90 s worst case. Running it inline inside the sequential
 * polling tick freezes price polling, leg monitoring and Telegram
 * handling for that whole window. This queue decouples execution from
 * the tick: callers enqueue a job and keep polling; at most one job runs
 * at a time, FIFO, and a throwing job is isolated from the rest of the
 * drain (logged, never rethrown to the enqueuer).
 */
export interface ExecutionJob {
  /** Short human-readable label for logs, e.g. "open-trade:<token-prefix>". */
  readonly description: string;
  run(): Promise<void>;
}

export class ExecutionQueue {
  private readonly pending: ExecutionJob[] = [];
  private draining = false;

  /** Enqueue a job and kick the drain. Returns immediately; never
   * awaits run(). Job failures are logged and isolated — they do not
   * propagate here. */
  enqueue(job: ExecutionJob): void {
    this.pending.push(job);
    console.log("Execution job enqueued", {
      description: job.description,
      pending: this.pending.length,
    });
    if (!this.draining) {
      // Floating promise: the drain guards itself with the draining
      // flag, and every per-job failure is caught inside the loop, so
      // there is no unhandled-rejection path.
      void this.drain();
    }
  }

  /** True while a job's run() is in flight. */
  isExecuting(): boolean {
    return this.draining;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        const startedAt = Date.now();
        console.log("Execution job started", { description: job.description });
        try {
          await job.run();
        } catch (error) {
          // Per-job error isolation: log and continue the drain with the
          // next job; never rethrow to the enqueuer (enqueue has already
          // returned) and never break the serial drain.
          console.error("Execution job failed", {
            description: job.description,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        console.log("Execution job completed", {
          description: job.description,
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
