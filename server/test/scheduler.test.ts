// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { createScheduler, type SchedulerJob, type JobResult } from "../src/scheduler.ts";

function makeJob(name: string, run: () => Promise<JobResult> = async () => ({})): SchedulerJob {
  return { name, run };
}

test("scheduler — start() invokes each job once per tick", async () => {
  let callCount = 0;
  const job = makeJob("test-job", async () => {
    callCount++;
    return {};
  });
  const scheduler = createScheduler({ tickIntervalMs: 50, jobs: [job] });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 175));
  await scheduler.stop();
  expect(callCount).toBeGreaterThanOrEqual(2);
  expect(callCount).toBeLessThanOrEqual(4);
});

test("scheduler — _tick() runs all jobs once and returns", async () => {
  const calls: string[] = [];
  const scheduler = createScheduler({
    tickIntervalMs: 999_999, // long enough not to auto-fire
    jobs: [
      makeJob("a", async () => { calls.push("a"); return {}; }),
      makeJob("b", async () => { calls.push("b"); return {}; }),
    ],
  });
  await scheduler._tick();
  expect(calls).toEqual(["a", "b"]);
});

test("scheduler — in-flight guard prevents overlap", async () => {
  let started = 0;
  let finished = 0;
  const slowJob = makeJob("slow", async () => {
    started++;
    await new Promise((r) => setTimeout(r, 100));
    finished++;
    return {};
  });
  const scheduler = createScheduler({ tickIntervalMs: 20, jobs: [slowJob] });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 250));
  await scheduler.stop();
  // With overlap guard: by 250ms with 100ms jobs, expect 2-3 completed runs, not 12.
  expect(finished).toBeLessThanOrEqual(3);
  expect(started).toBe(finished);
});

test("scheduler — failing job logs but doesn't crash; subsequent jobs run", async () => {
  const calls: string[] = [];
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    jobs: [
      makeJob("failing", async () => { calls.push("failing"); throw new Error("boom"); }),
      makeJob("after", async () => { calls.push("after"); return {}; }),
    ],
  });
  await scheduler._tick();
  expect(calls).toEqual(["failing", "after"]);
});

test("scheduler — stop() drains in-flight job", async () => {
  let finished = false;
  const scheduler = createScheduler({
    tickIntervalMs: 50,
    jobs: [makeJob("slow", async () => {
      await new Promise((r) => setTimeout(r, 80));
      finished = true;
      return {};
    })],
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 20)); // let first tick start
  await scheduler.stop();
  expect(finished).toBe(true);
});

test("scheduler — stop(timeoutMs) returns within timeout even if job hangs", async () => {
  const scheduler = createScheduler({
    tickIntervalMs: 50,
    jobs: [makeJob("hang", async (_ctx) => {
      // Ignore signal — simulate misbehaving job that doesn't honor abort
      await new Promise((r) => setTimeout(r, 5000));
      return {};
    })],
  });
  scheduler.start();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await scheduler.stop(100);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(200);
});

test("scheduler — shouldRun() returning false skips the tick", async () => {
  let jobCalls = 0;
  const scheduler = createScheduler({
    tickIntervalMs: 999_999,
    shouldRun: async () => false,
    jobs: [makeJob("counter", async () => { jobCalls++; return {}; })],
  });
  await scheduler._tick();
  expect(jobCalls).toBe(0);
});

test("scheduler — logs warning on drift > tickIntervalMs/2", async () => {
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };

  try {
    const scheduler = createScheduler({
      tickIntervalMs: 50,
      jobs: [makeJob("fast", async () => ({}))],
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 30));
    // Simulate drift by blocking the event loop briefly before next tick
    const blockUntil = Date.now() + 60;
    while (Date.now() < blockUntil) {/* block */}
    await new Promise((r) => setTimeout(r, 100));
    await scheduler.stop();
    expect(warns.some((w) => w.includes("scheduler: tick drifted"))).toBe(true);
  } finally {
    console.warn = origWarn;
  }
});

test("scheduler — logs error when tick is skipped due to in-flight previous", async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  try {
    const scheduler = createScheduler({
      tickIntervalMs: 20,
      jobs: [makeJob("slow", async () => {
        await new Promise((r) => setTimeout(r, 150)); // way longer than interval
        return {};
      })],
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    await scheduler.stop();
    expect(errors.some((e) => e.includes("tick skipped — previous tick still running"))).toBe(true);
  } finally {
    console.error = origError;
  }
});
