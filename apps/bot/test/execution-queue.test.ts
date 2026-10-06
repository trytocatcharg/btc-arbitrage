import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "../src/trading/execution-queue.js";

/** Resolves on a real macrotask so the detached drain can progress. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("enqueue returns before the job completes", async () => {
  const queue = new ExecutionQueue();
  const gate = deferred();
  let jobFinished = false;

  queue.enqueue({
    description: "slow-job",
    run: async () => {
      await gate.promise;
      jobFinished = true;
    },
  });

  // The caller continued past enqueue while the job is still pending.
  assert.equal(jobFinished, false);
  assert.equal(queue.isExecuting(), true);

  gate.resolve();
  await flush();
  assert.equal(jobFinished, true);
});

test("jobs run serially in FIFO order", async () => {
  const queue = new ExecutionQueue();
  const gate = deferred();
  const events: string[] = [];

  queue.enqueue({
    description: "job-1",
    run: async () => {
      events.push("job-1:start");
      await gate.promise;
      events.push("job-1:end");
    },
  });
  queue.enqueue({
    description: "job-2",
    run: async () => {
      events.push("job-2:start");
    },
  });

  await flush();
  // job-2 must not start while job-1 is blocked.
  assert.deepEqual(events, ["job-1:start"]);

  gate.resolve();
  await flush();
  assert.deepEqual(events, ["job-1:start", "job-1:end", "job-2:start"]);
});

test("a throwing job is logged and does not block the next job", async () => {
  const queue = new ExecutionQueue();
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    let nextRan = false;
    queue.enqueue({
      description: "failing-job",
      run: async () => {
        throw new Error("boom");
      },
    });
    queue.enqueue({
      description: "next-job",
      run: async () => {
        nextRan = true;
      },
    });

    await flush();
    assert.equal(nextRan, true);
    const failureLog = errors.find((args) => args[0] === "Execution job failed");
    assert.ok(failureLog, "expected an Execution job failed log");
    assert.equal(
      (failureLog[1] as { description: string }).description,
      "failing-job",
    );
    assert.equal((failureLog[1] as { message: string }).message, "boom");
  } finally {
    console.error = originalError;
  }
});

test("a job enqueued from inside a running job runs in the same drain pass, after it", async () => {
  const queue = new ExecutionQueue();
  const events: string[] = [];

  queue.enqueue({
    description: "outer-job",
    run: async () => {
      events.push("outer");
      queue.enqueue({
        description: "inner-job",
        run: async () => {
          events.push("inner");
        },
      });
    },
  });

  await flush();
  assert.deepEqual(events, ["outer", "inner"]);
  assert.equal(queue.isExecuting(), false);
});

test("isExecuting() is true while a job is in flight and false after", async () => {
  const queue = new ExecutionQueue();
  assert.equal(queue.isExecuting(), false);

  const gate = deferred();
  queue.enqueue({
    description: "blocked-job",
    run: async () => {
      await gate.promise;
    },
  });
  assert.equal(queue.isExecuting(), true);

  gate.resolve();
  await flush();
  assert.equal(queue.isExecuting(), false);
});
