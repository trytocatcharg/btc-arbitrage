/** Serial in-process execution queue for trade execution.
 *
 * Trade execution (limit fill wait, hedge, TP/SL) can block for tens of
 * seconds. Running it inline freezes the polling loop, price polling, and
 * Telegram handling. This queue decouples execution: callers enqueue a job
 * and return immediately; a detached drain runs at most one job at a time
 * in FIFO order, isolating per-job errors so one failure never stalls or
 * kills the drain.
 */
export interface ExecutionJob {
  /** Short human-readable label for logs, e.g. "open-trade:<token-prefix>". */
  readonly description: string;
  run(): Promise<void>;
}

export class ExecutionQueue {
  private readonly jobs: ExecutionJob[] = [];
  private draining = false;
  private executing = false;

  /** Returns immediately; the job runs later on the detached drain. */
  enqueue(job: ExecutionJob): void {
    this.jobs.push(job);
    console.log("Execution job enqueued", {
      description: job.description,
      pending: this.jobs.length,
    });
    // Floating promise by design: callers never await job completion and
    // never observe drain errors (each job's failure is logged in-drain).
    void this.drain();
  }

  /** True while a job's run() is in flight. */
  isExecuting(): boolean {
    return this.executing;
  }

  private async drain(): Promise<void> {
    // The flag prevents concurrent drains when enqueue is called while a
    // drain is already in flight; the while loop below also picks up jobs
    // enqueued from inside a running job within the same pass.
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift()!;
        const startedAt = Date.now();
        this.executing = true;
        console.log("Execution job started", {
          description: job.description,
          pending: this.jobs.length,
        });
        try {
          await job.run();
          console.log("Execution job completed", {
            description: job.description,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          // Error isolation: log and keep draining; never rethrow to the
          // enqueuer and never let one failed job stall the queue.
          console.error("Execution job failed", {
            description: job.description,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.executing = false;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
