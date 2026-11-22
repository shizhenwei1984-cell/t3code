import type {
  MessageId,
  NodeId,
  ProviderTurnId,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ReplySpeed =
  | { source: "native" | "average"; value: number }
  | { source: "unavailable" };

type Run = Pick<OrchestrationV2Run, "id" | "rootNodeId" | "status" | "startedAt" | "completedAt">;
type Turn = Pick<OrchestrationV2ProviderTurn, "id" | "nodeId" | "status" | "turnTokenUsage">;
interface Item {
  type: string;
  runId: RunId | null;
  nodeId: NodeId | null;
  providerTurnId?: ProviderTurnId | null;
  status?: string;
  messageId?: MessageId;
  message?: string;
}

export function replySpeeds(
  runs: readonly Run[],
  turns: readonly Turn[],
  visible: readonly { item: Item }[],
) {
  const results = new Map<MessageId, ReplySpeed>();
  const completed = new Map(
    runs.filter((run) => run.status === "completed").map((run) => [run.id, run]),
  );
  const turnOwners = new Map(turns.map((turn) => [turn.id, turn.nodeId]));
  const totals = new Map<NodeId, number | null>();
  for (const turn of turns) {
    const usage = turn.turnTokenUsage;
    const previous = totals.get(turn.nodeId);
    const measured =
      turn.status === "completed" && usage?.usageStatus === "complete" && !usage.localCommand;
    totals.set(
      turn.nodeId,
      previous !== null && measured ? (previous ?? 0) + usage.outputTokens : null,
    );
  }
  const replies = new Map<RunId, MessageId>();
  const native = new Map<RunId, number>();
  for (const { item } of visible) {
    if (!item.runId) continue;
    const run = completed.get(item.runId);
    if (!run) continue;
    // Message and notice nodes identify individual items. The provider turn identifies their agent.
    const owner = item.providerTurnId ? turnOwners.get(item.providerTurnId) : item.nodeId;
    if (owner != null && owner !== run.rootNodeId) continue;
    if (item.type === "assistant_message" && item.status === "completed" && item.messageId) {
      replies.set(item.runId, item.messageId);
    }
    if (item.type === "system_notice" && item.message) {
      // Only provider notices, never assistant prose or tool output.
      const match = /^TPS\s+(\d+(?:\.\d+)?)\s+tok(?:ens)?\/s\b/i.exec(item.message.trim());
      if (match && Number.isFinite(Number(match[1]))) native.set(item.runId, Number(match[1]));
    }
  }
  for (const [id, messageId] of replies) {
    const run = completed.get(id)!;
    const rate = native.get(id);
    const tokens = run.rootNodeId && totals.get(run.rootNodeId);
    const elapsed =
      run.startedAt && run.completedAt
        ? DateTime.toEpochMillis(run.completedAt) - DateTime.toEpochMillis(run.startedAt)
        : 0;
    if (rate !== undefined) results.set(messageId, { source: "native", value: rate });
    else if (tokens != null && elapsed > 0)
      results.set(messageId, { source: "average", value: (tokens * 1000) / elapsed });
    else results.set(messageId, { source: "unavailable" });
  }
  return results;
}
