import { useState } from "react";

/** A new turn's query is briefly empty while the server counts this thread's calls. */
export function useThreadToolCallCount(threadKey: string, count: number | null) {
  const [last, setLast] = useState({ threadKey, count });
  if (threadKey !== last.threadKey || (count !== null && count !== last.count)) {
    setLast({ threadKey, count });
    return count;
  }
  return last.count;
}
