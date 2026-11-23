import {
  latestProviderTurnForAttempt,
  type MessageId,
  type NodeId,
  type ProviderTurnId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type RunId,
  type ThreadUsageSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ReplySpeed =
  | { source: "native" | "average"; value: number }
  | { source: "unavailable" };

type LiveReplySpeed =
  | { source: "live"; value: number }
  | { source: "last-measured"; value: number };

interface OutputSample {
  reportedAt: number;
  outputTokens: number;
}

interface TurnObservation {
  key: ProviderTurnId;
  usageRevision: string;
  sample: OutputSample | null;
}

export type ComposerTurnStatsInput =
  | { kind: "settled"; revision: string; speed: ReplySpeed | undefined }
  | { kind: "live"; runKey: RunId; observation: TurnObservation | null };

export interface ComposerTurnStats {
  readonly speed: ReplySpeed | LiveReplySpeed | undefined;
  readonly usage: ThreadUsageSummary | null;
}

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

function usageRevision(turn: Turn | undefined) {
  const usage = turn?.turnTokenUsage;
  return JSON.stringify([
    turn?.id,
    usage?.usageStatus,
    usage?.localCommand,
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.cachedInputTokens,
  ]);
}

export function composerTurnStatsInput(input: {
  runs: readonly Pick<
    OrchestrationV2Run,
    "id" | "rootNodeId" | "status" | "activeAttemptId" | "completedAt"
  >[];
  turns: readonly (Turn &
    Pick<OrchestrationV2ProviderTurn, "ordinal" | "runAttemptId" | "tokenUsage">)[];
  settledSpeed: ReplySpeed | undefined;
}): ComposerTurnStatsInput {
  const active = input.runs.findLast(
    ({ status }) =>
      status === "preparing" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting",
  );
  const run = active ?? input.runs.findLast(({ completedAt }) => completedAt !== null);
  const turn = latestProviderTurnForAttempt(
    input.turns.filter((candidate) => candidate.nodeId === run?.rootNodeId),
    run?.activeAttemptId ?? null,
  );
  if (active === undefined) {
    return {
      kind: "settled",
      revision: JSON.stringify([run?.id, usageRevision(turn)]),
      speed: input.settledSpeed,
    };
  }
  if (turn === undefined) return { kind: "live", runKey: active.id, observation: null };
  const usage = turn.turnTokenUsage;
  const reportedAt = turn.tokenUsage ? Date.parse(turn.tokenUsage.updatedAt) : NaN;
  const sample =
    turn.status === "running" &&
    usage?.usageStatus === "partial" &&
    !usage.localCommand &&
    usage.outputTokens !== undefined &&
    Number.isFinite(reportedAt)
      ? { reportedAt, outputTokens: usage.outputTokens }
      : null;
  return {
    kind: "live",
    runKey: active.id,
    observation: { key: turn.id, usageRevision: usageRevision(turn), sample },
  };
}

const REFRESH_DELAY_MS = 1500;
const MAX_REFRESH_DELAY_MS = 5000;
const SAMPLE_WINDOW_MS = 8000;
const RETAINED_SPEED_TTL_MS = 180_000;

function appendOutputSample(samples: readonly OutputSample[], sample: OutputSample) {
  return [
    ...samples.filter(({ reportedAt }) => reportedAt >= sample.reportedAt - SAMPLE_WINDOW_MS),
    sample,
  ];
}

function measureRate(samples: readonly OutputSample[]): number | undefined {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || first === last) return undefined;
  const elapsedMs = last.reportedAt - first.reportedAt;
  if (elapsedMs <= 0) return undefined;
  return ((last.outputTokens - first.outputTokens) * 1000) / elapsedMs;
}

export function createComposerTurnStats({
  readUsage,
  publish,
}: {
  readUsage: (signal: AbortSignal) => Promise<ThreadUsageSummary>;
  publish: (stats: ComposerTurnStats) => void;
}) {
  let input: ComposerTurnStatsInput | undefined;
  let published: ComposerTurnStats = { speed: undefined, usage: null };
  let samples: readonly OutputSample[] = [];
  let lastReportedAt = -Infinity;
  let lastOutputTokens: number | undefined;
  let retainedSpeed: LiveReplySpeed | undefined;
  let measurementId = 0;
  let staleEpoch = 0;
  let clearEpoch = 0;
  let request: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  function display(next: ComposerTurnStats) {
    if (
      next.speed?.source === published.speed?.source &&
      (next.speed && "value" in next.speed ? next.speed.value : undefined) ===
        (published.speed && "value" in published.speed ? published.speed.value : undefined) &&
      next.usage === published.usage
    ) {
      return;
    }
    published = next;
    publish(next);
  }

  function clearSpeedTimers() {
    clearTimeout(staleTimer);
    clearTimeout(clearTimer);
    staleTimer = clearTimer = undefined;
  }

  function clearRetainedSpeed() {
    retainedSpeed = undefined;
    clearEpoch += 1;
  }

  function clearSpeed() {
    clearRetainedSpeed();
    display({ ...published, speed: undefined });
  }

  function resetLiveTracking() {
    clearSpeedTimers();
    samples = [];
    lastReportedAt = -Infinity;
    lastOutputTokens = undefined;
  }

  function cancelRefresh() {
    clearTimeout(refreshTimer);
    clearTimeout(maxWaitTimer);
    refreshTimer = maxWaitTimer = undefined;
  }

  function resolveLiveSpeedOnResponse(
    capturedSpeed: LiveReplySpeed | undefined,
    capturedMeasurementId: number,
    capturedStaleEpoch: number,
    capturedClearEpoch: number,
  ): LiveReplySpeed | undefined {
    if (capturedClearEpoch !== clearEpoch || capturedSpeed === undefined) return undefined;
    if (capturedMeasurementId === measurementId) return retainedSpeed;
    if (capturedSpeed.source === "live" && capturedStaleEpoch !== staleEpoch) {
      return { source: "last-measured", value: capturedSpeed.value };
    }
    return capturedSpeed;
  }

  function startRefresh(resolveSpeed: () => ComposerTurnStats["speed"]) {
    cancelRefresh();
    request?.abort();
    const { signal } = (request = new AbortController());
    const finish = (usage: ThreadUsageSummary | null) => {
      if (signal.aborted) return;
      request = undefined;
      display({
        speed: input?.kind === "settled" ? input.speed : resolveSpeed(),
        usage,
      });
    };
    void readUsage(signal).then(finish, () => finish(published.usage));
  }

  function refreshLive(speed: LiveReplySpeed | undefined = retainedSpeed) {
    const capturedMeasurementId = measurementId;
    const capturedStaleEpoch = staleEpoch;
    const capturedClearEpoch = clearEpoch;
    startRefresh(() =>
      resolveLiveSpeedOnResponse(
        speed,
        capturedMeasurementId,
        capturedStaleEpoch,
        capturedClearEpoch,
      ),
    );
  }

  function scheduleSpeedTimers() {
    clearSpeedTimers();
    staleTimer = setTimeout(() => {
      staleTimer = undefined;
      samples = [];
      if (retainedSpeed?.source !== "live") return;
      staleEpoch += 1;
      retainedSpeed = { source: "last-measured", value: retainedSpeed.value };
      if (published.speed?.source === "live") {
        display({
          ...published,
          speed: { source: "last-measured", value: published.speed.value },
        });
      }
    }, SAMPLE_WINDOW_MS);
    clearTimer = setTimeout(() => {
      clearTimer = undefined;
      clearSpeed();
    }, RETAINED_SPEED_TTL_MS);
  }

  function observe(sample: OutputSample) {
    if (sample.reportedAt <= lastReportedAt) return;
    lastReportedAt = sample.reportedAt;
    const counterReset = lastOutputTokens !== undefined && sample.outputTokens < lastOutputTokens;
    if (!counterReset && sample.outputTokens === lastOutputTokens) return;
    lastOutputTokens = sample.outputTokens;
    if (counterReset) {
      clearSpeedTimers();
      clearSpeed();
      samples = [sample];
      return;
    }
    samples = appendOutputSample(samples, sample);
    const rate = measureRate(samples);
    if (rate === undefined) return;
    measurementId += 1;
    retainedSpeed = { source: "live", value: rate };
    scheduleSpeedTimers();
  }

  return {
    update(next: ComposerTurnStatsInput) {
      const previous = input;
      input = next;
      if (next.kind === "settled") {
        if (previous?.kind !== "settled" || previous.revision !== next.revision) {
          resetLiveTracking();
          clearRetainedSpeed();
          startRefresh(() => undefined);
        } else if (request === undefined) {
          display({ ...published, speed: next.speed });
        }
        return;
      }
      const last = previous?.kind === "live" ? previous : undefined;
      const runChanged = last?.runKey !== next.runKey;
      const turnChanged = last?.observation?.key !== next.observation?.key;
      if (runChanged || turnChanged) {
        resetLiveTracking();
        clearSpeed();
      }
      if (next.observation?.sample) observe(next.observation.sample);
      if (previous === undefined || (last !== undefined && runChanged)) {
        refreshLive(undefined);
        return;
      }
      if (next.observation?.usageRevision === last?.observation?.usageRevision) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshLive(), REFRESH_DELAY_MS);
      maxWaitTimer ??= setTimeout(() => refreshLive(), MAX_REFRESH_DELAY_MS);
    },
    dispose() {
      cancelRefresh();
      resetLiveTracking();
      clearRetainedSpeed();
      request?.abort();
      request = undefined;
    },
  };
}
