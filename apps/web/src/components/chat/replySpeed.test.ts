import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { MessageId, NodeId, ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import { composerTurnStatsInput, createComposerTurnStats, replySpeeds } from "./replySpeed";

const id = RunId.make("run");
const rootNodeId = NodeId.make("root");
const run = {
  id,
  rootNodeId,
  status: "completed",
  startedAt: DateTime.makeUnsafe(1000),
  completedAt: DateTime.makeUnsafe(5000),
} as const;
const messageId = MessageId.make("final");
const reply = {
  item: {
    type: "assistant_message",
    status: "completed",
    runId: id,
    nodeId: rootNodeId,
    messageId,
  },
} as const;
const turn = {
  id: ProviderTurnId.make("root-turn"),
  nodeId: rootNodeId,
  status: "completed",
  turnTokenUsage: {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    outputTokens: 80,
    inputTokens: 40,
  },
} as const;

describe("reply output speed", () => {
  it("uses full run wall time and only complete main-agent output, once on the final reply", () => {
    const speeds = replySpeeds(
      [run],
      [turn, { ...turn, id: ProviderTurnId.make("child-turn"), nodeId: NodeId.make("child") }],
      [{ item: { ...reply.item, messageId: MessageId.make("earlier") } }, reply],
    );
    expect([...speeds]).toEqual([[messageId, { source: "average", value: 20 }]]);
  });
  it("joins native message nodes to the main agent through their provider turn", () => {
    const item = { ...reply.item, nodeId: NodeId.make("native-message"), providerTurnId: turn.id };
    expect(replySpeeds([run], [turn], [{ item }]).get(messageId)).toEqual({
      source: "average",
      value: 20,
    });
    const child = { ...turn, id: ProviderTurnId.make("child"), nodeId: NodeId.make("subagent") };
    const notice = {
      item: {
        type: "system_notice",
        runId: id,
        nodeId: NodeId.make("native-notice"),
        providerTurnId: child.id,
        message: "TPS 99 tok/s",
      },
    };
    expect(replySpeeds([run], [turn, child], [{ item }, notice]).get(messageId)).toEqual({
      source: "average",
      value: 20,
    });
  });
  it("prefers a provider performance notice over calculated speed", () => {
    const notice = {
      item: {
        type: "system_notice",
        runId: id,
        nodeId: rootNodeId,
        message: "TPS 227.1 tok/s · TTFT 3.4s",
      },
    } as const;
    expect(replySpeeds([run], [turn], [reply, notice]).get(messageId)).toEqual({
      source: "native",
      value: 227.1,
    });
  });
  it("distinguishes missing usage and invalid duration from genuine zero output; hides running turns", () => {
    expect(replySpeeds([run], [], [reply]).get(messageId)).toEqual({ source: "unavailable" });
    expect(
      replySpeeds([{ ...run, completedAt: run.startedAt }], [turn], [reply]).get(messageId),
    ).toEqual({ source: "unavailable" });
    expect(replySpeeds([{ ...run, status: "running" }], [turn], [reply]).size).toBe(0);
    expect(
      replySpeeds(
        [run],
        [{ ...turn, turnTokenUsage: { ...turn.turnTokenUsage, outputTokens: 0 } }],
        [reply],
      ).get(messageId),
    ).toEqual({ source: "average", value: 0 });
  });
});

const emptyUsage = { totalTokens: null, complete: false, cacheHitRate: null };
function trackSpeed(display: (speed: unknown) => void) {
  let lastSpeed: unknown;
  const stats = createComposerTurnStats({
    readUsage: () => Promise.resolve(emptyUsage),
    publish: ({ speed }) => {
      if (speed !== lastSpeed) display(speed);
      lastSpeed = speed;
    },
  });
  stats.update({ kind: "live", runKey: id, observation: null });
  return {
    observe: (sample: { reportedAt: number; outputTokens: number }) =>
      stats.update({
        kind: "live",
        runKey: id,
        observation: { key: turn.id, usageRevision: String(sample.outputTokens), sample },
      }),
    dispose: stats.dispose,
  };
}

describe("live composer speed", () => {
  it("uses the running root provider turn and restores the completed speed when it settles", () => {
    const attemptId = RunAttemptId.make("attempt");
    const active = { ...run, status: "running", activeAttemptId: attemptId } as const;
    const updatedAt = "2026-11-23T00:00:00.000Z";
    const runningTurn = {
      ...turn,
      ordinal: 1,
      runAttemptId: attemptId,
      status: "running",
      tokenUsage: { usedTokens: 9, outputTokens: 3, updatedAt },
      turnTokenUsage: { ...turn.turnTokenUsage, usageStatus: "partial" },
    } as const;
    const child = { ...runningTurn, ordinal: 2, nodeId: NodeId.make("child"), runAttemptId: null };
    const speed = { source: "average", value: 20 } as const;
    expect(
      composerTurnStatsInput({
        runs: [active],
        turns: [child],
        settledSpeed: speed,
      }),
    ).toEqual({ kind: "live", runKey: id, observation: null });
    const input = {
      runs: [active],
      turns: [runningTurn, child],
      settledSpeed: speed,
    };
    const live = composerTurnStatsInput(input);
    expect(live).toMatchObject({
      kind: "live",
      observation: { sample: { outputTokens: 80, reportedAt: Date.parse(updatedAt) } },
    });
    expect(
      composerTurnStatsInput({
        ...input,
        turns: [{ ...runningTurn, id: ProviderTurnId.make("continued-turn"), ordinal: 2 }],
      }),
    ).not.toEqual(live);
    expect(
      composerTurnStatsInput({
        ...input,
        runs: [{ ...active, id: RunId.make("another-run") }],
      }),
    ).not.toEqual(live);
    for (const usage of [{ inputTokens: 50 }, { cachedInputTokens: 5 }]) {
      expect(
        composerTurnStatsInput({
          ...input,
          turns: [{ ...runningTurn, turnTokenUsage: { ...runningTurn.turnTokenUsage, ...usage } }],
        }),
      ).not.toEqual(live);
    }
    expect(
      composerTurnStatsInput({ ...input, runs: [{ ...run, activeAttemptId: null }] }),
    ).toMatchObject({
      kind: "settled",
      speed,
    });
  });

  it("coalesces a burst for 1500 ms, marks stale at eight seconds, and clears after 180 seconds without output", async () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = trackSpeed(display);
      live.observe({ reportedAt: 1000, outputTokens: 10 });
      await vi.advanceTimersByTimeAsync(500);
      live.observe({ reportedAt: 1500, outputTokens: 20 });
      await vi.advanceTimersByTimeAsync(500);
      live.observe({ reportedAt: 2000, outputTokens: 50 });
      await vi.advanceTimersByTimeAsync(1499);
      expect(display).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 40 });
      await vi.advanceTimersByTimeAsync(5000);
      live.observe({ reportedAt: 8500, outputTokens: 50 });
      await vi.advanceTimersByTimeAsync(1499);
      expect(display).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(display).toHaveBeenLastCalledWith({ source: "last-measured", value: 40 });
      await vi.advanceTimersByTimeAsync(171_999);
      expect(display).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(display).toHaveBeenLastCalledWith(undefined);
      live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes speed and session usage together on the live cadence", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const baseline = { totalTokens: 1000, complete: true, cacheHitRate: 0.5 };
      const liveUsage = { totalTokens: 1500, complete: false, cacheHitRate: 0.25 };
      const finalUsage = { totalTokens: 1600, complete: true, cacheHitRate: 0.3 };
      const older = Promise.withResolvers<typeof liveUsage>();
      const readUsage = vi
        .fn()
        .mockResolvedValueOnce(baseline)
        .mockResolvedValueOnce(liveUsage)
        .mockReturnValueOnce(older.promise)
        .mockResolvedValueOnce(finalUsage);
      const stats = createComposerTurnStats({ readUsage, publish });
      const observe = (
        reportedAt: number,
        outputTokens: number,
        usageRevision = String(reportedAt),
      ) =>
        stats.update({
          kind: "live",
          runKey: id,
          observation: { key: turn.id, usageRevision, sample: { reportedAt, outputTokens } },
        });

      observe(1000, 10);
      await vi.advanceTimersByTimeAsync(500);
      observe(1500, 20);
      await vi.advanceTimersByTimeAsync(500);
      observe(1500, 20);
      await vi.advanceTimersByTimeAsync(999);
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: baseline });
      await vi.advanceTimersByTimeAsync(1);
      const liveSpeed = { source: "live", value: 20 };
      expect(publish).toHaveBeenLastCalledWith({ speed: liveSpeed, usage: liveUsage });

      // Input and cache changes keep the debounce busy even when output stays constant.
      for (let index = 0; index < 5; index += 1) {
        if (index > 0) await vi.advanceTimersByTimeAsync(1000);
        observe(2000 + index * 1000, 20);
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(readUsage).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(readUsage).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenLastCalledWith({ speed: liveSpeed, usage: liveUsage });

      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: liveUsage,
      });
      stats.update({
        kind: "settled",
        revision: "completed",
        speed: { source: "average", value: 10 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "average", value: 10 },
        usage: finalUsage,
      });
      older.resolve(liveUsage);
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "average", value: 10 },
        usage: finalUsage,
      });
      stats.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains stale speed across solitary samples and input/cache refreshes, restores live on a fresh pair, and clears only speed after 180 seconds", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const usageAt = (totalTokens: number) => ({
        totalTokens,
        complete: false,
        cacheHitRate: 0.4,
      });
      const u0 = usageAt(100);
      const u1 = usageAt(200);
      const u2 = usageAt(300);
      const u3 = usageAt(400);
      const u4 = usageAt(500);
      const u5 = usageAt(600);
      const u6 = usageAt(700);
      const readUsage = vi
        .fn()
        .mockResolvedValueOnce(u0)
        .mockResolvedValueOnce(u1)
        .mockResolvedValueOnce(u2)
        .mockResolvedValueOnce(u3)
        .mockResolvedValueOnce(u4)
        .mockResolvedValueOnce(u5)
        .mockResolvedValueOnce(u6);
      const stats = createComposerTurnStats({ readUsage, publish });
      const observe = (reportedAt: number, outputTokens: number, usageRevision: string) =>
        stats.update({
          kind: "live",
          runKey: id,
          observation: { key: turn.id, usageRevision, sample: { reportedAt, outputTokens } },
        });

      observe(1000, 10, "r0");
      await vi.advanceTimersByTimeAsync(500);
      observe(1500, 20, "r1");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 20 },
        usage: u1,
      });

      await vi.advanceTimersByTimeAsync(6500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u1,
      });

      // Input/cache-only refresh publishes new totals without clearing or marking speed live.
      await vi.advanceTimersByTimeAsync(10_000);
      observe(19_500, 20, "r2");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u2,
      });

      // Solitary output sample after the 8s gap preserves retained speed.
      await vi.advanceTimersByTimeAsync(10_000);
      observe(31_000, 60, "r3");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u3,
      });

      // A second sample within 8s forms a valid pair and restores live after the 1500ms debounce.
      await vi.advanceTimersByTimeAsync(500);
      observe(33_000, 120, "r4");
      await vi.advanceTimersByTimeAsync(1499);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u3,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 30 },
        usage: u4,
      });

      // Stale at 8s from the new pair (t=32_000 -> t=40_000).
      await vi.advanceTimersByTimeAsync(6500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 30 },
        usage: u4,
      });

      // Neither input/cache-only updates nor a solitary sample extend the 180s retention lifetime.
      await vi.advanceTimersByTimeAsync(60_000);
      observe(101_000, 120, "r5");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 30 },
        usage: u5,
      });

      await vi.advanceTimersByTimeAsync(48_500);
      observe(151_000, 130, "r6");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 30 },
        usage: u6,
      });

      await vi.advanceTimersByTimeAsync(60_499);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 30 },
        usage: u6,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(publish).toHaveBeenLastCalledWith({
        speed: undefined,
        usage: u6,
      });
      stats.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prevents in-flight requests from resurrecting live or expired speed and preserves usage on transient read failure", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const u0 = { totalTokens: 100, complete: true, cacheHitRate: 0.5 };
      const u1 = { totalTokens: 200, complete: false, cacheHitRate: 0.4 };
      const u2 = { totalTokens: 300, complete: false, cacheHitRate: 0.45 };
      const u3 = { totalTokens: 400, complete: false, cacheHitRate: 0.5 };
      const acrossStale = Promise.withResolvers<typeof u2>();
      const acrossClear = Promise.withResolvers<typeof u3>();
      const readUsage = vi
        .fn()
        .mockResolvedValueOnce(u0)
        .mockResolvedValueOnce(u1)
        .mockReturnValueOnce(acrossStale.promise)
        .mockRejectedValueOnce(new Error("transient network error"))
        .mockReturnValueOnce(acrossClear.promise);
      const stats = createComposerTurnStats({ readUsage, publish });
      const observe = (reportedAt: number, outputTokens: number, usageRevision: string) =>
        stats.update({
          kind: "live",
          runKey: id,
          observation: { key: turn.id, usageRevision, sample: { reportedAt, outputTokens } },
        });

      observe(1000, 10, "r0");
      await vi.advanceTimersByTimeAsync(500);
      observe(1500, 20, "r1");
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 20 },
        usage: u1,
      });

      // Start an in-flight usage refresh while live, then cross the 8s stale boundary before it resolves.
      await vi.advanceTimersByTimeAsync(4500);
      observe(7500, 20, "r2");
      await vi.advanceTimersByTimeAsync(1500);
      expect(readUsage).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u1,
      });

      acrossStale.resolve(u2);
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u2,
      });

      // Transient usage read failure preserves previously published session usage.
      await vi.advanceTimersByTimeAsync(1500);
      observe(11_000, 20, "r3");
      await vi.advanceTimersByTimeAsync(1500);
      expect(readUsage).toHaveBeenCalledTimes(4);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "last-measured", value: 20 },
        usage: u2,
      });

      // Start an in-flight refresh before 180s expiry, then cross 180s before it resolves.
      await vi.advanceTimersByTimeAsync(167_000);
      observe(179_500, 20, "r4");
      await vi.advanceTimersByTimeAsync(1500);
      expect(readUsage).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: undefined,
        usage: u2,
      });

      acrossClear.resolve(u3);
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({
        speed: undefined,
        usage: u3,
      });
      stats.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears retained speed on provider turn switch, run switch, and dispose while keeping thread usage", async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const u0 = { totalTokens: 100, complete: false, cacheHitRate: 0.2 };
      const u1 = { totalTokens: 200, complete: false, cacheHitRate: 0.3 };
      const u2 = { totalTokens: 250, complete: false, cacheHitRate: 0.35 };
      const u3 = { totalTokens: 300, complete: false, cacheHitRate: 0.4 };
      const u4 = { totalTokens: 400, complete: false, cacheHitRate: 0.45 };
      const u5 = { totalTokens: 500, complete: false, cacheHitRate: 0.5 };
      const u6 = { totalTokens: 600, complete: false, cacheHitRate: 0.55 };
      const fromTurnOne = Promise.withResolvers<typeof u2>();
      const readUsage = vi
        .fn()
        .mockResolvedValueOnce(u0)
        .mockResolvedValueOnce(u1)
        .mockReturnValueOnce(fromTurnOne.promise)
        .mockResolvedValueOnce(u3)
        .mockResolvedValueOnce(u4)
        .mockResolvedValueOnce(u5)
        .mockResolvedValueOnce(u6);
      const stats = createComposerTurnStats({ readUsage, publish });
      const turnTwo = ProviderTurnId.make("turn-two");
      const runTwo = RunId.make("run-two");
      const turnThree = ProviderTurnId.make("turn-three");

      stats.update({
        kind: "live",
        runKey: id,
        observation: {
          key: turn.id,
          usageRevision: "t1-0",
          sample: { reportedAt: 1000, outputTokens: 10 },
        },
      });
      await vi.advanceTimersByTimeAsync(500);
      stats.update({
        kind: "live",
        runKey: id,
        observation: {
          key: turn.id,
          usageRevision: "t1-1",
          sample: { reportedAt: 1500, outputTokens: 20 },
        },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 20 },
        usage: u1,
      });

      // Launch an in-flight request for turn 1, then switch to turn 2 before it settles.
      stats.update({
        kind: "live",
        runKey: id,
        observation: {
          key: turn.id,
          usageRevision: "t1-2",
          sample: { reportedAt: 3000, outputTokens: 20 },
        },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(readUsage).toHaveBeenCalledTimes(3);

      stats.update({
        kind: "live",
        runKey: id,
        observation: {
          key: turnTwo,
          usageRevision: "t2-0",
          sample: { reportedAt: 4000, outputTokens: 5 },
        },
      });
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: u1 });

      fromTurnOne.resolve(u2);
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: u2 });

      // Turn 2 with only a single sample does not inherit turn 1's speed.
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: u3 });

      // Measure a pair in turn 2, then switch runs.
      stats.update({
        kind: "live",
        runKey: id,
        observation: {
          key: turnTwo,
          usageRevision: "t2-1",
          sample: { reportedAt: 5000, outputTokens: 55 },
        },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 50 },
        usage: u4,
      });

      stats.update({
        kind: "live",
        runKey: runTwo,
        observation: {
          key: turnThree,
          usageRevision: "t3-0",
          sample: { reportedAt: 7000, outputTokens: 10 },
        },
      });
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: u4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(publish).toHaveBeenLastCalledWith({ speed: undefined, usage: u5 });

      // Measure a pair in run 2, dispose, and confirm no stale or 180s timer fires afterward.
      stats.update({
        kind: "live",
        runKey: runTwo,
        observation: {
          key: turnThree,
          usageRevision: "t3-1",
          sample: { reportedAt: 8000, outputTokens: 70 },
        },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(publish).toHaveBeenLastCalledWith({
        speed: { source: "live", value: 60 },
        usage: u6,
      });

      const callsBeforeDispose = publish.mock.calls.length;
      stats.dispose();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(publish).toHaveBeenCalledTimes(callsBeforeDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards in-flight usage when switching threads", async () => {
    const older = Promise.withResolvers<typeof emptyUsage>();
    const publish = vi.fn();
    const first = createComposerTurnStats({ readUsage: () => older.promise, publish });
    const settled = { kind: "settled", revision: "done", speed: undefined } as const;
    first.update(settled);
    first.dispose();

    const newThread = { totalTokens: 500, complete: true, cacheHitRate: 0.1 };
    const second = createComposerTurnStats({
      readUsage: () => Promise.resolve(newThread),
      publish,
    });
    second.update(settled);
    older.resolve(emptyUsage);
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledExactlyOnceWith({ speed: undefined, usage: newThread });
    second.dispose();
  });

  it("publishes by five seconds under sustained usage and discards pending updates on disposal", async () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = trackSpeed(display);
      for (let index = 0; index <= 4; index += 1) {
        if (index > 0) await vi.advanceTimersByTimeAsync(1000);
        live.observe({ reportedAt: 1000 + index * 1000, outputTokens: 10 + index * 20 });
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(display).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(display).toHaveBeenCalledExactlyOnceWith({ source: "live", value: 20 });
      live.observe({ reportedAt: 6000, outputTokens: 120 });
      live.dispose();
      await vi.advanceTimersByTimeAsync(8000);
      expect(display).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the rate to recent samples, ignores stale timestamps, and restarts on counter reset", async () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = trackSpeed(display);
      live.observe({ reportedAt: 1000, outputTokens: 10 });
      live.observe({ reportedAt: 5000, outputTokens: 50 });
      live.observe({ reportedAt: 10000, outputTokens: 75 });
      live.observe({ reportedAt: 10000, outputTokens: 500 });
      live.observe({ reportedAt: 9500, outputTokens: 400 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 5 });

      live.observe({ reportedAt: 11000, outputTokens: 2 });
      expect(display).toHaveBeenLastCalledWith(undefined);
      live.observe({ reportedAt: 12000, outputTokens: 14 });
      await vi.advanceTimersByTimeAsync(1500);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 12 });

      // Output counter reset also clears retained speed after the 8s sample window has gone stale.
      await vi.advanceTimersByTimeAsync(6500);
      expect(display).toHaveBeenLastCalledWith({ source: "last-measured", value: 12 });
      live.observe({ reportedAt: 21000, outputTokens: 1 });
      expect(display).toHaveBeenLastCalledWith(undefined);
      live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
