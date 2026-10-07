import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { scheduleWorkerActive, startScheduleWorker, stopScheduleWorker, workerEnabled } from "../src/worker.js";

const keys = ["CONTENT_SCHEDULER_ENABLED", "CONTENT_DISABLE_WORKER", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

describe("scheduler is off unless a process opts in", () => {
  afterEach(() => {
    stopScheduleWorker();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("stays disabled by default, and the kill switch wins over the enable flag", () => {
    for (const key of keys) saved[key] = process.env[key];
    delete process.env.CONTENT_SCHEDULER_ENABLED;
    delete process.env.CONTENT_DISABLE_WORKER;
    process.env.NODE_ENV = "production";

    assert.equal(workerEnabled(), false);
    startScheduleWorker();
    assert.equal(scheduleWorkerActive(), false);

    process.env.CONTENT_SCHEDULER_ENABLED = "1";
    assert.equal(workerEnabled(), true);
    startScheduleWorker();
    assert.equal(scheduleWorkerActive(), true);
    stopScheduleWorker();
    assert.equal(scheduleWorkerActive(), false);

    process.env.CONTENT_DISABLE_WORKER = "1";
    assert.equal(workerEnabled(), false);
    startScheduleWorker();
    assert.equal(scheduleWorkerActive(), false);

    delete process.env.CONTENT_DISABLE_WORKER;
    process.env.NODE_ENV = "test";
    assert.equal(workerEnabled(), false);
  });
});
