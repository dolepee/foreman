import { createHash, timingSafeEqual } from "node:crypto";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HASH = /^[a-fA-F0-9]{64}$/;

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function controlledFailureConfig(env = process.env) {
  const id = String(env.FOREMAN_CONTROLLED_FAILURE_ID || "").trim();
  const authorizationHash = String(env.FOREMAN_CONTROLLED_FAILURE_AUTH_SHA256 || "").trim().toLowerCase();
  const payer = String(env.FOREMAN_CONTROLLED_FAILURE_PAYER || "").trim().toLowerCase();
  const expiresAt = Date.parse(String(env.FOREMAN_CONTROLLED_FAILURE_EXPIRES_AT || ""));

  if (!id && !authorizationHash && !payer && !Number.isFinite(expiresAt)) return null;
  if (!id || !HASH.test(authorizationHash) || !ADDRESS.test(payer) || !Number.isFinite(expiresAt)) {
    throw new Error("controlled_failure_configuration_invalid");
  }
  return { id, authorizationHash, payer, expiresAt };
}

export function readControlledFailure(body) {
  const queue = [{ value: body, depth: 0 }];
  const seen = new Set();
  let candidate = null;
  while (queue.length > 0 && !candidate) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    if (value.controlledProviderFailure) {
      candidate = value.controlledProviderFailure;
      break;
    }
    if (depth >= 3) continue;
    for (const key of ["input", "data", "payload", "request", "parameters", "arguments", "requirements"]) {
      if (value[key] && typeof value[key] === "object") {
        queue.push({ value: value[key], depth: depth + 1 });
      }
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return {
    id: String(candidate.id || "").trim(),
    authorization: String(candidate.authorization || "").trim(),
  };
}

export function authorizeControlledFailure({ request, config, now = Date.now() }) {
  if (!request) return { requested: false, authorized: false };
  if (!config) return { requested: true, authorized: false, reason: "controlled_failure_disabled" };
  if (now > config.expiresAt) return { requested: true, authorized: false, reason: "controlled_failure_expired" };
  if (!request.id || !sameText(request.id, config.id)) {
    return { requested: true, authorized: false, reason: "controlled_failure_id_mismatch" };
  }
  if (!request.authorization || !sameText(hash(request.authorization), config.authorizationHash)) {
    return { requested: true, authorized: false, reason: "controlled_failure_authorization_invalid" };
  }
  return { requested: true, authorized: true };
}

export function payerMatchesControlledFailure(payer, config) {
  return Boolean(
    config
    && ADDRESS.test(String(payer || ""))
    && sameText(String(payer).toLowerCase(), config.payer),
  );
}
