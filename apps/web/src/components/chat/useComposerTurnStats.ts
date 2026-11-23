import { RegistryContext } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useId, useRef, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import {
  createComposerTurnStats,
  type ComposerTurnStats,
  type ComposerTurnStatsInput,
} from "./replySpeed";

export function useComposerTurnStats(
  thread: ScopedThreadRef | null | undefined,
  input: ComposerTurnStatsInput | undefined,
): ComposerTurnStats {
  const registry = useContext(RegistryContext);
  const scope = useId();
  const { environmentId, threadId } = thread ?? {};
  const key = thread ? JSON.stringify([environmentId, threadId]) : undefined;
  const tracker = useRef<ReturnType<typeof createComposerTurnStats> | null>(null);
  const revision = useRef(0);
  const [published, setPublished] = useState<ComposerTurnStats & { key: string | undefined }>({
    key,
    speed: undefined,
    usage: null,
  });
  if (published.key !== key) setPublished({ key, speed: undefined, usage: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the timers and usage request for this thread
  useEffect(() => {
    if (environmentId === undefined || threadId === undefined) return;
    const controller = createComposerTurnStats({
      readUsage: (signal) =>
        Effect.runPromise(
          AtomRegistry.getResult(
            registry,
            orchestrationEnvironment.threadUsageSummary({
              environmentId,
              input: { threadId, revision: `${scope}:${++revision.current}` },
            }),
            { suspendOnWaiting: true },
          ),
          { signal },
        ),
      publish: (stats) => setPublished((state) => (state.key === key ? { key, ...stats } : state)),
    });
    tracker.current = controller;
    return () => {
      controller.dispose();
      tracker.current = null;
    };
  }, [environmentId, key, registry, scope, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds committed provider telemetry to the thread's timers
  useEffect(() => {
    if (key !== undefined && input !== undefined) tracker.current?.update(input);
  }, [input, key]);

  return published.key === key ? published : { speed: undefined, usage: null };
}
