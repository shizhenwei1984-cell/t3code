import {
  latestProviderTurnForAttempt,
  type MessageId,
  type NodeId,
  type ProviderTurnId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ReplySpeed =
  | { source: "native" | "average"; value: number }
  | { source: "unavailable" };

export type LiveReplySpeed = { source: "live"; value: number };

interface OutputSample {
  reportedAt: number;
  outputTokens: number;
}

export type ComposerReplySpeed =
  | { kind: "settled"; speed: ReplySpeed | undefined }
  | { kind: "live"; observation: { key: string; sample: OutputSample } | null };

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

export function composerReplySpeed(input: {
  threadKey: string;
  runs: readonly Pick<OrchestrationV2Run, "id" | "rootNodeId" | "status" | "activeAttemptId">[];
  turns: readonly (Turn &
    Pick<OrchestrationV2ProviderTurn, "ordinal" | "runAttemptId" | "tokenUsage">)[];
  settledSpeed: ReplySpeed | undefined;
}): ComposerReplySpeed {
  const run = input.runs.findLast(
    ({ status }) =>
      status === "preparing" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting",
  );
  if (run === undefined) return { kind: "settled", speed: input.settledSpeed };
  const turn = latestProviderTurnForAttempt(
    input.turns.filter((candidate) => candidate.nodeId === run.rootNodeId),
    run.activeAttemptId,
  );
  const usage = turn?.turnTokenUsage;
  if (
    turn?.status !== "running" ||
    usage?.usageStatus !== "partial" ||
    usage.localCommand ||
    usage.outputTokens === undefined ||
    turn.tokenUsage === undefined
  ) {
    return { kind: "live", observation: null };
  }
  const reportedAt = Date.parse(turn.tokenUsage.updatedAt);
  if (!Number.isFinite(reportedAt)) return { kind: "live", observation: null };
  return {
    kind: "live",
    observation: {
      key: JSON.stringify([input.threadKey, run.id, turn.id]),
      sample: { reportedAt, outputTokens: usage.outputTokens },
    },
  };
}

const REFRESH_DELAY_MS = 1500;
const MAX_REFRESH_DELAY_MS = 5000;
const SAMPLE_WINDOW_MS = 8000;

function appendOutputSample(samples: readonly OutputSample[], sample: OutputSample) {
  const previous = samples.at(-1);
  if (previous === undefined || sample.outputTokens < previous.outputTokens) return [sample];
  return [
    ...samples.filter(({ reportedAt }) => reportedAt >= sample.reportedAt - SAMPLE_WINDOW_MS),
    sample,
  ];
}

export function createLiveReplySpeed(onChange: (speed: LiveReplySpeed | undefined) => void) {
  let samples: readonly OutputSample[] = [];
  let lastReportedAt = -Infinity;
  let published: number | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function updateDisplay(value: number | undefined) {
    if (value === published) return;
    published = value;
    onChange(value === undefined ? undefined : { source: "live", value });
  }

  function cancelRefresh() {
    clearTimeout(refreshTimer);
    clearTimeout(maxWaitTimer);
    refreshTimer = maxWaitTimer = undefined;
  }

  function refresh() {
    cancelRefresh();
    const first = samples[0];
    const last = samples.at(-1);
    if (first !== undefined && last !== undefined && first !== last) {
      updateDisplay(
        ((last.outputTokens - first.outputTokens) * 1000) / (last.reportedAt - first.reportedAt),
      );
    }
  }

  return {
    observe(sample: OutputSample) {
      if (sample.reportedAt <= lastReportedAt) return;
      lastReportedAt = sample.reportedAt;
      if (sample.outputTokens === samples.at(-1)?.outputTokens) return;
      samples = appendOutputSample(samples, sample);
      if (samples.length === 1) {
        cancelRefresh();
        updateDisplay(undefined);
      }
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        samples = [];
        updateDisplay(undefined);
      }, SAMPLE_WINDOW_MS);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
      maxWaitTimer ??= setTimeout(refresh, MAX_REFRESH_DELAY_MS);
    },
    dispose() {
      cancelRefresh();
      clearTimeout(expiryTimer);
    },
  };
}
