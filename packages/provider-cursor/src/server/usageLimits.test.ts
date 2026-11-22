import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./usageLimits.ts";

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("reports the billing-cycle length so pace can be computed", () => {
    const planUsage = { totalPercentUsed: 40, autoPercentUsed: 30, apiPercentUsed: 20 };
    const durations = (billingCycleStart: string | number | undefined, billingCycleEnd: string) =>
      cursorUsageResponseToLimits(
        { billingCycleStart, billingCycleEnd, planUsage },
        checkedAt,
      ).windows.map((window) => window.windowDurationMins);
    expect(durations("1794045847072", "1796637847072")).toEqual([43_200, 43_200, 43_200]);
    expect(durations(1_796_637_847_072, "1799316247072")).toEqual([44_640, 44_640, 44_640]);
  });

  it("omits the cycle length when the start is missing or invalid", () => {
    for (const billingCycleStart of [undefined, "", "0", "not-a-number", "1796637847072"]) {
      expect(
        cursorUsageResponseToLimits(
          {
            billingCycleStart,
            billingCycleEnd: "1796637847072",
            planUsage: { totalPercentUsed: 40 },
          },
          checkedAt,
        ).windows,
      ).toEqual([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 40,
          resetsAt: "2026-12-07T10:04:07.072Z",
        },
      ]);
    }
  });

  it("retains unified totals for account aggregation", () => {
    const windows = cursorUsageResponseToLimits(
      { planUsage: { totalPercentUsed: 1.77, autoPercentUsed: 1.77 } },
      checkedAt,
    ).windows;
    expect(windows.map((window) => window.id)).toEqual(["autoPercentUsed", "totalPercentUsed"]);
    expect(
      cursorUsageResponseToLimits(
        { planUsage: { totalPercentUsed: 100, apiPercentUsed: 100 } },
        checkedAt,
      ).windows.map((window) => window.id),
    ).toEqual(["apiPercentUsed", "totalPercentUsed"]);
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it.effect("reads the personal on-demand budget independently of team spending", () =>
    Effect.gen(function* () {
      const token = "test." + Buffer.from('{"sub":"test-account"}').toString("base64url") + ".sig";
      for (const [enabled, limit] of [
        [true, null],
        [true, 2000],
        [false, 0],
      ] as const) {
        const result = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_AUTH_TOKEN: token },
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const dashboard = request.url === "https://cursor.com/api/usage-summary";
              if (dashboard) {
                expect(request.headers.cookie).toBe(
                  "WorkosCursorSessionToken=" + encodeURIComponent("test-account::" + token),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json(
                    dashboard
                      ? { individualUsage: { onDemand: { enabled, used: 125, limit } } }
                      : {
                          planUsage: { totalPercentUsed: 21 },
                          spendLimitUsage: { pooledLimit: 99000 },
                        },
                  ),
                ),
              );
            }),
          ),
        );
        expect(result.windows[0]?.usedPercent).toBe(21);
        expect(result).toHaveProperty("checkedAt");
        if (enabled)
          expect(result).toHaveProperty("onDemand", { spentCents: 125, limitCents: limit });
        else expect(result).not.toHaveProperty("onDemand");
      }
    }),
  );

  it.effect("uses a CLI dashboard session only for the exchanged API key's account", () =>
    Effect.gen(function* () {
      const jwt = (sub: string, sig: string) =>
        "test." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + "." + sig;
      for (const subject of ["personal", "different"]) {
        let calls = 0;
        const cli = jwt(subject, "cli");
        const result = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          { CURSOR_API_KEY: "fixture" },
          Effect.succeed(cli),
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              let body: unknown = { planUsage: { totalPercentUsed: 11 } };
              if (request.url.endsWith("/auth/exchange_user_api_key"))
                body = { accessToken: jwt("personal", "key") };
              if (request.url === "https://cursor.com/api/usage-summary") {
                calls++;
                expect(request.headers.cookie).toBe(
                  "WorkosCursorSessionToken=" + encodeURIComponent("personal::" + cli),
                );
                body = { individualUsage: { onDemand: { enabled: true, used: 0, limit: 0 } } };
              }
              return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
            }),
          ),
        );
        expect(calls).toBe(subject === "personal" ? 1 : 0);
        if (subject === "personal")
          expect(result).toHaveProperty("onDemand", { spentCents: 0, limitCents: 0 });
        else expect(result).not.toHaveProperty("onDemand");
        expect(result.windows[0]?.usedPercent).toBe(11);
      }
    }),
  );

  it.effect("requires explicit credentials and accepts an auth token", () =>
    Effect.gen(function* () {
      for (const token of [undefined, "explicit-token"]) {
        const limits = yield* readCursorUsageLimits(
          { apiEndpoint: "" },
          token ? { CURSOR_AUTH_TOKEN: token } : {},
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              expect(token).toBe("explicit-token");
              expect(request.headers.authorization).toBe("Bearer explicit-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ planUsage: { totalPercentUsed: 10 } }),
                ),
              );
            }),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect("reports failed requests without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_AUTH_TOKEN: "private-token" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      );
      expect(limits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Cursor could not read usage limits.",
      });
    }),
  );

  it.effect("exchanges an API key to read its account limits", () =>
    Effect.gen(function* () {
      const requests: Array<readonly [string, string | undefined]> = [];
      const limits = yield* readCursorUsageLimits(
        { apiEndpoint: "" },
        { CURSOR_API_KEY: "api-key" },
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push([request.url, request.headers.authorization]);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json(
                  request.url.endsWith("/auth/exchange_user_api_key")
                    ? { accessToken: "api-key-access-token" }
                    : { planUsage: { totalPercentUsed: 37 } },
                ),
              ),
            );
          }),
        ),
      );
      expect(requests).toEqual([
        ["https://api2.cursor.sh/auth/exchange_user_api_key", "Bearer api-key"],
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          "Bearer api-key-access-token",
        ],
      ]);
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }),
  );

  it.effect("does not send an API key to a custom endpoint", () =>
    Effect.gen(function* () {
      for (const [apiEndpoint, environment] of [
        ["http://localhost:3000", { CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "http://localhost:3000", CURSOR_API_KEY: "api-key" }],
        ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example", CURSOR_API_KEY: "api-key" }],
        ["https://cursor-proxy.example", { CURSOR_API_KEY: "api-key" }],
      ] as const) {
        const limits = yield* readCursorUsageLimits({ apiEndpoint }, environment).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send an API key to a proxy")),
          ),
        );
        expect(limits.unavailable?.reason).toBe("unsupported");
        expect(limits.unavailable?.message).toContain("default Cursor endpoint");
      }
    }),
  );
});
