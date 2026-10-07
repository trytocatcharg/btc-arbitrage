import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  ExecutionQueue,
  type ExecutionJob,
} from "../src/trading/execution-queue.js";

/** Deferred promise helper for controlling job completion in tests. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks so the queue's drain can advance. */
async function tick(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("ExecutionQueue", () => {
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;

  before(() => {
    // Keep test output focused on assertions.
    console.error = () => {};
    console.log = () => {};
  });

  after(() => {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  it("enqueue returns before the job completes", async () => {
    const queue = new ExecutionQueue();
    const gate = deferred();
    let completed = false;

    queue.enqueue({
      description: "slow-job",
      run: async () => {
        await gate.promise;
        completed = true;
      },
    });

    await tick();
    assert.equal(completed, false, "job must not be complete yet");
    gate.resolve();
    await tick();
    assert.equal(completed, true, "job completes after its gate resolves");
  });

  it("runs jobs serially in FIFO order", async () => {
    const queue = new ExecutionQueue();
    const events: string[] = [];
    const gate = deferred();

    queue.enqueue({
      description: "job-1",
      run: async () => {
        events.push("job1:start");
        await gate.promise;
        events.push("job1:end");
      },
    });
    queue.enqueue({
      description: "job-2",
      run: async () => {
        events.push("job2:start");
      },
    });

    await tick();
    assert.deepEqual(
      events,
      ["job1:start"],
      "job2 must not start while job1 is blocked",
    );

    gate.resolve();
    await tick();
    assert.deepEqual(events, ["job1:start", "job1:end", "job2:start"]);
  });

  it("isolates a throwing job and continues the drain", async () => {
    const queue = new ExecutionQueue();
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    const ran: string[] = [];

    queue.enqueue({
      description: "failing-job",
      run: async () => {
        throw new Error("boom");
      },
    });
    queue.enqueue({
      description: "following-job",
      run: async () => {
        ran.push("following-job");
      },
    });

    await tick();
    assert.deepEqual(ran, ["following-job"], "subsequent job must still run");
    assert.equal(errors.length, 1, "the failure must be logged exactly once");
    const [label, details] = errors[0] as [string, Record<string, unknown>];
    assert.equal(label, "Execution job failed");
    assert.equal(details.description, "failing-job");
    assert.equal(details.message, "boom");
    assert.equal(typeof details.durationMs, "number");
  });

  it("consumes a job enqueued from inside a running job in the same drain pass", async () => {
    const queue = new ExecutionQueue();
    const events: string[] = [];
    let enqueuedInner = false;

    queue.enqueue({
      description: "outer-job",
      run: async () => {
        events.push("outer:start");
        if (!enqueuedInner) {
          enqueuedInner = true;
          queue.enqueue({
            description: "inner-job",
            run: async () => {
              events.push("inner:start");
            },
          });
        }
        events.push("outer:end");
      },
    });

    await tick();
    // The inner job was enqueued during the drain; it must run in the
    // same pass, after the outer job finished (not before it).
    assert.deepEqual(events, ["outer:start", "outer:end", "inner:start"]);
  });

  it("reports isExecuting() true in flight and false after", async () => {
    const queue = new ExecutionQueue();
    const gate = deferred();
    const observed: boolean[] = [];

    queue.enqueue({
      description: "observed-job",
      run: async () => {
        observed.push(queue.isExecuting());
        await gate.promise;
      },
    });

    await tick();
    assert.deepEqual(observed, [true], "isExecuting() true while run() is in flight");

    gate.resolve();
    await tick();
    assert.equal(
      queue.isExecuting(),
      false,
      "isExecuting() false once the drain finishes",
    );
  });
});
