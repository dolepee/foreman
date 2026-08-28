type RelayRouteInput = Readonly<{
  agent: string;
  upstream: string;
  queryKeys?: readonly string[];
  queryValues?: Readonly<Record<string, readonly string[]>>;
  queryPatterns?: Readonly<Record<string, string>>;
  queryMaxLength?: number;
}>;

type RelayRoute = Readonly<{
  agent: string;
  upstream: URL;
  queryKeys: readonly string[];
  queryValues: Readonly<Record<string, readonly string[]>>;
  queryPatterns: Readonly<Record<string, RegExp>>;
  queryMaxLength: number;
}>;

export const RELAY_UPSTREAM_TIMEOUT_MS = 120_000;
export const RELAY_ROUTES = Object.freeze({
  "/foreman/api/launch-readiness-pack": Object.freeze({
    agent: "foreman",
    upstream: "https://foreman-nu-one.vercel.app/api/launch-readiness-pack",
  }),
  "/policypool/api/covered-job-receipt": Object.freeze({
    agent: "policypool",
    upstream: "https://policypool.vercel.app/api/covered-job-receipt",
    queryKeys: Object.freeze(["quote"]),
    queryPatterns: Object.freeze({ quote: "^ppq_[a-f0-9]{32}\\.[a-f0-9]{64}$" }),
  }),
  "/policypool/api/coverage-preflight": Object.freeze({
    agent: "policypool",
    upstream: "https://policypool.vercel.app/api/coverage-preflight",
  }),
  "/policypool/api/coverage-ledger": Object.freeze({
    agent: "policypool",
    upstream: "https://policypool.vercel.app/api/coverage-ledger",
  }),
  "/policypool/api/coverage-status": Object.freeze({
    agent: "policypool",
    upstream: "https://policypool.vercel.app/api/coverage-status",
    queryKeys: Object.freeze(["receiptId", "id"]),
    queryMaxLength: 80,
  }),
  "/policypool/api/provider-relay": Object.freeze({
    agent: "policypool",
    upstream: "https://policypool.vercel.app/api/provider-relay",
  }),
  "/conviction/api/service": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/service?reviewerRelay=1",
  }),
  "/conviction/api/manage": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/manage?reviewerRelay=1",
  }),
  "/conviction/api/refresh": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/refresh?reviewerRelay=1",
  }),
  "/conviction/api/quickstart": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/executor?document=quickstart&reviewerRelay=1",
  }),
  "/conviction/api/health": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/health",
  }),
  "/conviction/api/readiness": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/readiness?reviewerRelay=1",
  }),
  "/conviction/api/preview": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/preview",
  }),
  "/conviction/api/executor": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/executor?reviewerRelay=1",
  }),
  "/conviction/api/receipt": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/receipt",
    queryKeys: Object.freeze(["proofType"]),
    queryValues: Object.freeze({ proofType: Object.freeze(["activation-terminal", "close", "recovery"]) }),
    queryMaxLength: 19,
  }),
  "/conviction/.well-known/x402": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/executor?document=x402&reviewerRelay=1",
  }),
  "/conviction/openapi.json": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/executor?document=openapi&reviewerRelay=1",
  }),
  "/conviction/llms.txt": Object.freeze({
    agent: "conviction",
    upstream: "https://conviction-bay.vercel.app/api/executor?document=llms&reviewerRelay=1",
  }),
} satisfies Readonly<Record<string, RelayRouteInput>>);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ALLOWED_METHODS = Object.freeze(["GET", "HEAD", "POST", "OPTIONS"]);
const REQUEST_HEADERS = Object.freeze(["accept", "content-type", "payment-signature", "x-payment"]);
const RESPONSE_HEADERS = Object.freeze([
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "allow",
  "cache-control",
  "content-type",
  "payment-required",
  "payment-response",
  "x-payment-response",
]);

class RelayError extends Error {
  readonly code: "payload_too_large" | "response_too_large";

  constructor(code: "payload_too_large" | "response_too_large") {
    super(code);
    this.code = code;
  }
}

function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("content-type", "application/json; charset=utf-8");
  resultHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: resultHeaders });
}

function relayFailure(error: string, settlementAmbiguous = false): Response {
  if (settlementAmbiguous) {
    return jsonResponse(502, {
      ok: false,
      error: "upstream_settlement_ambiguous",
      cause: error,
      charged: null,
      settlement: "unknown",
      retryable: false,
      nextAction: "RECONCILE_PAYMENT_BEFORE_RETRY",
    });
  }
  return jsonResponse(502, { ok: false, error, charged: false });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  code: RelayError["code"],
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel(code);
        throw new RelayError(code);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validatedRoutes(routes: Readonly<Record<string, RelayRouteInput>>): ReadonlyMap<string, RelayRoute> {
  const pinned = new Map<string, RelayRoute>();
  for (const [publicPath, route] of Object.entries(routes)) {
    const upstream = new URL(route.upstream);
    const queryKeys = route.queryKeys ?? [];
    const queryValues = route.queryValues ?? {};
    const queryPatterns = route.queryPatterns ?? {};
    const queryMaxLength = route.queryMaxLength ?? (Object.keys(queryPatterns).length ? 200 : 100);
    if (
      !publicPath.startsWith(`/${route.agent}/`) || publicPath.includes("?") || publicPath.includes("#") ||
      !/^[a-z][a-z0-9-]*$/.test(route.agent) || new Set(queryKeys).size !== queryKeys.length ||
      queryKeys.some((key) => !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) ||
      Object.entries(queryValues).some(([key, values]) =>
        !queryKeys.includes(key) || !values.length || new Set(values).size !== values.length ||
        values.some((value) => !value || value.length > 100)) ||
      Object.entries(queryPatterns).some(([key, pattern]) =>
        !queryKeys.includes(key) || pattern.length > 200 || !pattern.startsWith("^") || !pattern.endsWith("$")) ||
      !Number.isSafeInteger(queryMaxLength) || queryMaxLength < 1 || queryMaxLength > 200 ||
      upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.hash
    ) throw new TypeError("reviewer relay routes must bind one agent path to one HTTPS URL");
    pinned.set(publicPath, Object.freeze({
      agent: route.agent,
      upstream,
      queryKeys: Object.freeze([...queryKeys]),
      queryValues: Object.freeze(Object.fromEntries(Object.entries(queryValues).map(([key, values]) => [key, Object.freeze([...values])]))),
      queryPatterns: Object.freeze(Object.fromEntries(Object.entries(queryPatterns).map(([key, pattern]) => [key, new RegExp(pattern)]))),
      queryMaxLength,
    }));
  }
  return pinned;
}

function forwardedHeaders(request: Request, route: RelayRoute, publicHost: string): Headers {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-forwarded-host", publicHost);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-prefix", `/${route.agent}`);
  return headers;
}

function responseHeaders(upstream: Response, agent: string, requestId: string): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  headers.set("x-okx-review-relay", `${agent}-v2`);
  headers.set("x-request-id", requestId);
  return headers;
}

function stringContainsBlockedUpstreamName(text: string): boolean {
  if (/vercel/i.test(text)) return true;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(text) || text.length < 8) return false;
  try {
    return /vercel/i.test(atob(text));
  } catch {
    return false;
  }
}

function structuredContainsBlockedUpstreamName(value: unknown, depth = 0): boolean {
  if (depth > 20 || value === null || value === undefined) return false;
  if (typeof value === "string") return stringContainsBlockedUpstreamName(value);
  if (Array.isArray(value)) return value.some((entry) => structuredContainsBlockedUpstreamName(entry, depth + 1));
  if (typeof value === "object") {
    return Object.entries(value).some(([key, entry]) =>
      stringContainsBlockedUpstreamName(key) || structuredContainsBlockedUpstreamName(entry, depth + 1));
  }
  return false;
}

function containsBlockedUpstreamName(value: string): boolean {
  if (stringContainsBlockedUpstreamName(value)) return true;
  try {
    return structuredContainsBlockedUpstreamName(JSON.parse(value));
  } catch {
    return false;
  }
}

function responseExposesBlockedUpstream(upstream: Response, body: Uint8Array): boolean {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value && containsBlockedUpstreamName(value)) return true;
  }
  return upstream.status === 402 && containsBlockedUpstreamName(new TextDecoder().decode(body));
}

export function createRelayHandler(
  fetchImpl: typeof fetch = fetch,
  routes: Readonly<Record<string, RelayRouteInput>> = RELAY_ROUTES,
): (request: Request) => Promise<Response> {
  const pinnedRoutes = validatedRoutes(routes);
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const requestUrl = new URL(request.url);
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return jsonResponse(200, {
        ok: true,
        service: "OKX agent reviewer relay",
        runtime: "cloudflare-workers",
        agents: [...new Set([...pinnedRoutes.values()].map((route) => route.agent))],
      }, { "x-request-id": requestId });
    }
    const agentHealth = requestUrl.pathname.match(/^\/([a-z][a-z0-9-]*)\/healthz?$/);
    if (request.method === "GET" && agentHealth) {
      const agent = agentHealth[1];
      const routesForAgent = [...pinnedRoutes.entries()].filter(([, route]) => route.agent === agent).map(([path]) => path);
      return routesForAgent.length
        ? jsonResponse(200, { ok: true, agent, routes: routesForAgent }, { "x-request-id": requestId })
        : jsonResponse(404, { ok: false, error: "agent_not_found" }, { "x-request-id": requestId });
    }

    const route = pinnedRoutes.get(requestUrl.pathname);
    const queryEntries = [...requestUrl.searchParams.entries()];
    const [queryKey, queryValue] = queryEntries[0] ?? [];
    const allowedValues = queryKey ? route?.queryValues[queryKey] : undefined;
    const allowedPattern = queryKey ? route?.queryPatterns[queryKey] : undefined;
    const queryAllowed = queryEntries.length === 0 || (
      queryEntries.length === 1 && Boolean(route?.queryKeys.includes(queryKey)) && queryValue.length > 0 &&
      queryValue.length <= (route?.queryMaxLength ?? 0) && (!allowedValues || allowedValues.includes(queryValue)) &&
      (!allowedPattern || allowedPattern.test(queryValue))
    );
    if (!route || !queryAllowed) return jsonResponse(404, { ok: false, error: "route_not_found" }, { "x-request-id": requestId });
    if (!ALLOWED_METHODS.includes(request.method)) {
      return jsonResponse(405, { ok: false, error: "method_not_allowed" }, {
        allow: ALLOWED_METHODS.join(", "),
        "x-request-id": requestId,
      });
    }

    const paidReplayForwarded = Boolean(request.headers.get("payment-signature") || request.headers.get("x-payment"));
    try {
      const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readBoundedBody(request.body, MAX_BODY_BYTES, "payload_too_large");
      const upstreamUrl = new URL(route.upstream);
      for (const [key, value] of queryEntries) upstreamUrl.searchParams.set(key, value);
      const upstream = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: forwardedHeaders(request, route, requestUrl.hostname),
        body: body?.byteLength ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(RELAY_UPSTREAM_TIMEOUT_MS),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        throw new Error("upstream redirect refused");
      }
      const responseBody = await readBoundedBody(upstream.body, MAX_RESPONSE_BYTES, "response_too_large");
      if (responseExposesBlockedUpstream(upstream, responseBody)) {
        return relayFailure("upstream_response_not_reviewer_safe", paidReplayForwarded);
      }
      return new Response(request.method === "HEAD" ? null : responseBody, {
        status: upstream.status,
        headers: responseHeaders(upstream, route.agent, requestId),
      });
    } catch (error) {
      if (error instanceof RelayError && error.code === "payload_too_large") {
        return jsonResponse(413, { ok: false, error: error.code }, { "x-request-id": requestId });
      }
      if (error instanceof RelayError && error.code === "response_too_large") {
        return relayFailure("upstream_response_too_large", paidReplayForwarded);
      }
      console.error(JSON.stringify({
        level: "error",
        event: "upstream_failure",
        requestId,
        route: requestUrl.pathname,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : "unknown upstream failure",
      }));
      return relayFailure("upstream_unavailable", paidReplayForwarded);
    }
  };
}
