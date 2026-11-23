import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

interface ThreadRead {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}

export const fetchEnvironmentThreadTranscript = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadTranscript",
)(function* (input: ThreadRead) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadTranscript({ params: { threadId: input.threadId } }),
    timeoutMs: 60_000,
    request: ({ client, headers }) =>
      client.threadTranscript({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});

export const fetchEnvironmentThreadToolCallCount = (input: ThreadRead) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    timeoutMs: 10_000,
    url: (urls) => urls.threadToolCallCount({ params: { threadId: input.threadId } }),
    request: ({ client, headers }) =>
      client.threadToolCallCount({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });

export const fetchEnvironmentThreadUsageSummary = (input: ThreadRead) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    timeoutMs: 10_000,
    url: (urls) => urls.threadUsageSummary({ params: { threadId: input.threadId } }),
    request: ({ client, headers }) =>
      client.threadUsageSummary({
        params: { threadId: input.threadId },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
