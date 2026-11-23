import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { MessageId, NodeId, ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import { composerReplySpeed, createLiveReplySpeed, replySpeeds } from "./replySpeed";

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
      composerReplySpeed({
        threadKey: "thread",
        runs: [active],
        turns: [child],
        settledSpeed: speed,
      }),
    ).toEqual({ kind: "live", observation: null });
    const input = {
      threadKey: "thread",
      runs: [active],
      turns: [runningTurn, child],
      settledSpeed: speed,
    };
    const live = composerReplySpeed(input);
    expect(live).toMatchObject({
      kind: "live",
      observation: { sample: { outputTokens: 80, reportedAt: Date.parse(updatedAt) } },
    });
    expect(composerReplySpeed({ ...input, threadKey: "another-thread" })).not.toEqual(live);
    expect(
      composerReplySpeed({
        ...input,
        turns: [{ ...runningTurn, id: ProviderTurnId.make("continued-turn"), ordinal: 2 }],
      }),
    ).not.toEqual(live);
    expect(
      composerReplySpeed({
        ...input,
        runs: [{ ...active, id: RunId.make("another-run") }],
      }),
    ).not.toEqual(live);
    expect(composerReplySpeed({ ...input, runs: [{ ...run, activeAttemptId: null }] })).toEqual({
      kind: "settled",
      speed,
    });
  });

  it("coalesces a burst for 1500 ms and expires after eight seconds without output", () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = createLiveReplySpeed(display);
      live.observe({ reportedAt: 1000, outputTokens: 10 });
      vi.advanceTimersByTime(500);
      live.observe({ reportedAt: 1500, outputTokens: 20 });
      vi.advanceTimersByTime(500);
      live.observe({ reportedAt: 2000, outputTokens: 50 });
      vi.advanceTimersByTime(1499);
      expect(display).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 40 });
      vi.advanceTimersByTime(5000);
      live.observe({ reportedAt: 8500, outputTokens: 50 });
      vi.advanceTimersByTime(1499);
      expect(display).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(display).toHaveBeenLastCalledWith(undefined);
      live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes by five seconds under sustained usage and discards pending updates on disposal", () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = createLiveReplySpeed(display);
      for (let index = 0; index <= 4; index += 1) {
        if (index > 0) vi.advanceTimersByTime(1000);
        live.observe({ reportedAt: 1000 + index * 1000, outputTokens: 10 + index * 20 });
      }
      vi.advanceTimersByTime(999);
      expect(display).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(display).toHaveBeenCalledExactlyOnceWith({ source: "live", value: 20 });
      live.observe({ reportedAt: 6000, outputTokens: 120 });
      live.dispose();
      vi.advanceTimersByTime(8000);
      expect(display).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the rate to recent samples, ignores stale timestamps, and restarts on counter reset", () => {
    vi.useFakeTimers();
    const display = vi.fn();
    try {
      const live = createLiveReplySpeed(display);
      live.observe({ reportedAt: 1000, outputTokens: 10 });
      live.observe({ reportedAt: 5000, outputTokens: 50 });
      live.observe({ reportedAt: 10000, outputTokens: 75 });
      live.observe({ reportedAt: 10000, outputTokens: 500 });
      live.observe({ reportedAt: 9500, outputTokens: 400 });
      vi.advanceTimersByTime(1500);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 5 });

      live.observe({ reportedAt: 11000, outputTokens: 2 });
      expect(display).toHaveBeenLastCalledWith(undefined);
      live.observe({ reportedAt: 12000, outputTokens: 14 });
      vi.advanceTimersByTime(1500);
      expect(display).toHaveBeenLastCalledWith({ source: "live", value: 12 });
      live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
