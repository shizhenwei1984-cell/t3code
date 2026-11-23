import { useEffect, useRef, useState } from "react";
import { createLiveReplySpeed, type ComposerReplySpeed, type LiveReplySpeed } from "./replySpeed";

export function useComposerReplySpeed(input: ComposerReplySpeed | undefined) {
  const observation = input?.kind === "live" ? input.observation : null;
  const key = observation?.key;
  const reportedAt = observation?.sample.reportedAt;
  const outputTokens = observation?.sample.outputTokens;
  const sampler = useRef<ReturnType<typeof createLiveReplySpeed> | null>(null);
  const [published, setPublished] = useState<{
    key: string | undefined;
    speed: LiveReplySpeed | undefined;
  }>({ key, speed: undefined });
  if (published.key !== key) setPublished({ key, speed: undefined });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the refresh timers for the active provider turn
  useEffect(() => {
    if (key === undefined) return;
    const tracker = createLiveReplySpeed((speed) =>
      setPublished((state) => (state.key === key ? { key, speed } : state)),
    );
    sampler.current = tracker;
    return () => {
      tracker.dispose();
      sampler.current = null;
    };
  }, [key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards committed provider telemetry to the refresh timers
  useEffect(() => {
    if (key !== undefined && reportedAt !== undefined && outputTokens !== undefined) {
      sampler.current?.observe({ reportedAt, outputTokens });
    }
  }, [key, reportedAt, outputTokens]);

  if (input?.kind === "settled") return input.speed;
  return published.key === key ? published.speed : undefined;
}
