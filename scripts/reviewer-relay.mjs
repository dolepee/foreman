import http from "node:http";
import { pathToFileURL } from "node:url";

export const RELAY_HOST = "okx-agent-review-relay.onrender.com";
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
    queryPatterns: Object.freeze({
      quote: "^ppq_[a-f0-9]{32}\\.[a-f0-9]{64}$",
    }),
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
    upstream: "https://conviction-bay.vercel.app/api/readiness",
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
    queryValues: Object.freeze({
      proofType: Object.freeze(["activation-terminal", "close", "recovery"]),
    }),
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
});

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "payment-signature",
  "x-payment",
];
const RESPONSE_HEADERS = [
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
];

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function sendRelayFailure(response, error, settlementAmbiguous = false) {
  if (settlementAmbiguous) {
    return sendJson(response, 502, {
      ok: false,
      error: "upstream_settlement_ambiguous",
      cause: error,
      charged: null,
      settlement: "unknown",
      retryable: false,
      nextAction: "RECONCILE_PAYMENT_BEFORE_RETRY",
    });
  }
  return sendJson(response, 502, {
    ok: false,
    error,
    charged: false,
  });
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body exceeds relay limit");
      error.code = "payload_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(upstream) {
  if (!upstream.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_RESPONSE_BYTES) {
      const error = new Error("upstream response exceeds relay limit");
      error.code = "response_too_large";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function forwardRequestHeaders(request, route) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value) headers.set(name, value);
  }
  headers.set("x-forwarded-host", RELAY_HOST);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-prefix", `/${route.agent}`);
  return headers;
}

function copyResponseHeaders(upstream, response, agent) {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-okx-review-relay", `${agent}-v1`);
}

function stringContainsBlockedUpstreamName(text) {
  if (/vercel/i.test(text)) return true;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(text) || text.length < 8) return false;
  try {
    return /vercel/i.test(Buffer.from(text, "base64").toString("utf8"));
  } catch {
    return false;
  }
}

function structuredContainsBlockedUpstreamName(value, depth = 0) {
  if (depth > 20 || value === null || value === undefined) return false;
  if (typeof value === "string") return stringContainsBlockedUpstreamName(value);
  if (Array.isArray(value)) {
    return value.some((entry) => structuredContainsBlockedUpstreamName(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.entries(value).some(([key, entry]) =>
      stringContainsBlockedUpstreamName(key) ||
      structuredContainsBlockedUpstreamName(entry, depth + 1));
  }
  return false;
}

function containsBlockedUpstreamName(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  if (stringContainsBlockedUpstreamName(text)) return true;
  try {
    return structuredContainsBlockedUpstreamName(JSON.parse(text));
  } catch {
    return false;
  }
}

function responseExposesBlockedUpstream(upstream, body) {
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (containsBlockedUpstreamName(value)) return true;
  }
  return upstream.status === 402 && containsBlockedUpstreamName(body);
}

function validatedRoutes(routes) {
  const pinned = new Map();
  for (const [publicPath, route] of Object.entries(routes)) {
    const upstream = new URL(route?.upstream || "");
    const queryKeys = route?.queryKeys || [];
    const queryValues = route?.queryValues || {};
    const queryValueEntries = Object.entries(queryValues);
    const queryPatterns = route?.queryPatterns || {};
    const queryPatternEntries = Object.entries(queryPatterns);
    const queryMaxLength = route?.queryMaxLength ?? (
      queryPatternEntries.length > 0 ? 200 : 100
    );
    if (
      !publicPath.startsWith(`/${route?.agent}/`) ||
      publicPath.includes("?") ||
      publicPath.includes("#") ||
      !/^[a-z][a-z0-9-]*$/.test(route?.agent || "") ||
      !Array.isArray(queryKeys) ||
      new Set(queryKeys).size !== queryKeys.length ||
      queryKeys.some((key) => !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) ||
      queryValueEntries.some(([key, values]) =>
        !queryKeys.includes(key) ||
        !Array.isArray(values) ||
        values.length === 0 ||
        new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string" || !value || value.length > 100)) ||
      queryPatternEntries.some(([key, pattern]) =>
        !queryKeys.includes(key) ||
        typeof pattern !== "string" ||
        pattern.length > 200 ||
        !pattern.startsWith("^") ||
        !pattern.endsWith("$")) ||
      !Number.isSafeInteger(queryMaxLength) ||
      queryMaxLength < 1 ||
      queryMaxLength > 200 ||
      upstream.protocol !== "https:" ||
      upstream.username ||
      upstream.password ||
      upstream.hash
    ) {
      throw new TypeError("reviewer relay routes must bind one agent path to one HTTPS URL");
    }
    pinned.set(publicPath, Object.freeze({
      agent: route.agent,
      upstream,
      queryKeys: Object.freeze([...queryKeys]),
      queryValues: Object.freeze(Object.fromEntries(queryValueEntries.map(([key, values]) => [
        key,
        Object.freeze([...values]),
      ]))),
      queryPatterns: Object.freeze(Object.fromEntries(queryPatternEntries.map(([key, pattern]) => [
        key,
        new RegExp(pattern),
      ]))),
      queryMaxLength,
    }));
  }
  return pinned;
}

export function createReviewerRelayHandler({
  fetchImpl = fetch,
  routes = RELAY_ROUTES,
} = {}) {
  const pinnedRoutes = validatedRoutes(routes);

  return async function reviewerRelay(request, response) {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || "/", "http://reviewer-relay.local");
    } catch {
      return sendJson(response, 400, {
        ok: false,
        error: "invalid_request_target",
        charged: false,
      });
    }
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "OKX agent reviewer relay",
        agents: [...new Set([...pinnedRoutes.values()].map((route) => route.agent))],
      });
    }
    const agentHealth = requestUrl.pathname.match(/^\/([a-z][a-z0-9-]*)\/healthz?$/);
    if (request.method === "GET" && agentHealth) {
      const agent = agentHealth[1];
      const routesForAgent = [...pinnedRoutes.entries()]
        .filter(([, route]) => route.agent === agent)
        .map(([path]) => path);
      if (routesForAgent.length === 0) {
        return sendJson(response, 404, { ok: false, error: "agent_not_found" });
      }
      return sendJson(response, 200, { ok: true, agent, routes: routesForAgent });
    }

    const route = pinnedRoutes.get(requestUrl.pathname);
    const queryEntries = [...requestUrl.searchParams.entries()];
    const [queryKey, queryValue] = queryEntries[0] || [];
    const allowedValues = route?.queryValues?.[queryKey];
    const allowedPattern = route?.queryPatterns?.[queryKey];
    const queryAllowed = queryEntries.length === 0 || (
      queryEntries.length === 1 &&
      route?.queryKeys.includes(queryKey) &&
      queryValue.length > 0 &&
      queryValue.length <= route.queryMaxLength &&
      (!allowedValues || allowedValues.includes(queryValue)) &&
      (!allowedPattern || allowedPattern.test(queryValue))
    );
    if (!route || !queryAllowed) {
      return sendJson(response, 404, { ok: false, error: "route_not_found" });
    }
    if (!["GET", "HEAD", "POST", "OPTIONS"].includes(request.method || "")) {
      response.setHeader("allow", "GET, HEAD, POST, OPTIONS");
      return sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    }

    let paidReplayForwarded = false;
    try {
      const body = ["GET", "HEAD"].includes(request.method || "")
        ? undefined
        : await readRequestBody(request);
      const upstreamUrl = new URL(route.upstream);
      for (const [key, value] of queryEntries) upstreamUrl.searchParams.set(key, value);
      paidReplayForwarded = Boolean(
        request.headers["payment-signature"] || request.headers["x-payment"],
      );
      const upstreamResponse = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: forwardRequestHeaders(request, route),
        body: body?.length ? body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(RELAY_UPSTREAM_TIMEOUT_MS),
      });
      const responseBody = await readResponseBody(upstreamResponse);
      if (responseExposesBlockedUpstream(upstreamResponse, responseBody)) {
        return sendRelayFailure(
          response,
          "upstream_response_not_reviewer_safe",
          paidReplayForwarded,
        );
      }
      response.statusCode = upstreamResponse.status;
      copyResponseHeaders(upstreamResponse, response, route.agent);
      if (request.method === "HEAD") return response.end();
      return response.end(responseBody);
    } catch (error) {
      if (error?.code === "payload_too_large") {
        return sendJson(response, 413, { ok: false, error: "payload_too_large" });
      }
      if (error?.code === "response_too_large") {
        return sendRelayFailure(
          response,
          "upstream_response_too_large",
          paidReplayForwarded,
        );
      }
      return sendRelayFailure(response, "upstream_unavailable", paidReplayForwarded);
    }
  };
}

export function createReviewerRelayServer(options = {}) {
  return http.createServer(createReviewerRelayHandler(options));
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  const port = Number.parseInt(process.env.PORT || "3000", 10);
  createReviewerRelayServer().listen(port, "0.0.0.0", () => {
    console.log(`OKX agent reviewer relay listening on port ${port}`);
  });
}
