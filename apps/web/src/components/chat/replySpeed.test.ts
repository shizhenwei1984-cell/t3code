import { describe, expect, it } from "vitest";
import * as DateTime from "effect/DateTime";
import { MessageId, NodeId, RunId } from "@t3tools/contracts";
import { replySpeeds } from "./replySpeed";

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
      [turn, { ...turn, nodeId: NodeId.make("child") }],
      [{ item: { ...reply.item, messageId: MessageId.make("earlier") } }, reply],
    );
    expect([...speeds]).toEqual([[messageId, { source: "average", value: 20 }]]);
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
