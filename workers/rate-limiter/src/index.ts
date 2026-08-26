/*
 * api-rate-limiter: per-organization rate limiting gateway
 *
 * This Worker is the public-facing entrypoint for all API traffic. It enforces
 * per-organization rate limits and then proxies allowed requests to the upstream
 * API via a service binding. No request reaches the upstream unless it passes
 * the rate limit check.
 *
 * Request flow:
 *   Client -> [this Worker] -> ORG_RATE_LIMITER (Workers Rate Limiting binding)
 *                           -> MOCK_API (service binding, internal Worker)
 *
 * Organization ID extraction (in priority order):
 *   1. JWT Bearer token: reads the "organizationId" claim from the token payload
 *   2. URL path:         reads path segment [2] from /api/{orgId}/...
 *   3. Client IP:        fallback for requests that match neither pattern
 *
 * Rate limiting:
 *   Backed by the Workers Rate Limiting binding (wrangler.toml: [[ratelimits]]).
 *   A single binding covers all organizations: the "key" parameter isolates
 *   counters per org, so adding new organizations requires no configuration
 *   changes. Limit and window are set in wrangler.toml.
 *
 * SECURITY NOTE - JWT signature verification:
 *   This PoC decodes the JWT payload without verifying the signature. This is
 *   safe here because the rate limiter only uses the claim to choose a counter
 *   key, not to make authorization decisions. In production, API Shield would
 *   validate the signature upstream before this Worker runs.
 */

/**
 * Binding interface for the Cloudflare Workers Rate Limiting API.
 * Declared here because @cloudflare/workers-types does not yet export it.
 * Docs: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Bindings declared in wrangler.toml and injected by the Workers runtime.
 *   MOCK_API         - service binding to the internal api-mock-backend Worker
 *   ORG_RATE_LIMITER - rate limiting binding, keyed per organization ID
 */
interface Env {
  MOCK_API: Fetcher;
  ORG_RATE_LIMITER: RateLimit;
}

/**
 * Decodes the payload segment of a JWT without verifying the signature.
 *
 * JWTs are three base64url-encoded segments separated by dots:
 *   <header>.<payload>.<signature>
 * We only need the payload (index 1), which contains the claims as JSON.
 * base64url differs from standard base64: uses '-' and '_' instead of '+' and '/'.
 *
 * Returns the parsed claims object, or null if the token is malformed.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const payload = parts[1];
    // Normalize base64url to standard base64, then pad to a multiple of 4 characters.
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
    const binary = atob(padded);
    // atob() returns a binary string; convert it to a byte array for TextDecoder.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Determines the organization ID and authentication method from the request.
 *
 * Priority:
 *   1. JWT Bearer token (Authorization: Bearer <token>)
 *      Decodes the payload and reads the "organizationId" claim.
 *      Falls through if the header is absent, the token is malformed,
 *      or the claim is missing or not a string/number.
 *   2. URL path segment (for API Key authenticated requests)
 *      Reads path[2] from the pattern /api/{orgId}/... .
 *      This lets a single rule cover all API Key requests without
 *      needing to know the set of valid organization IDs in advance.
 *   3. Client IP (CF-Connecting-IP)
 *      Last resort for requests that do not match either pattern above.
 *
 * The returned "method" field is forwarded to the upstream as X-Auth-Method
 * and included in 429 responses so callers can see which path was taken.
 */
function extractOrgId(request: Request): { orgId: string; method: "jwt" | "apikey" | "ip" } {
  // --- Path 1: JWT Bearer token ---
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const payload = decodeJwtPayload(auth.slice(7));
    if (payload) {
      const orgIdClaim = payload.organizationId;
      if (typeof orgIdClaim === "string" || typeof orgIdClaim === "number") {
        return { orgId: String(orgIdClaim), method: "jwt" };
      }
    }
  }

  // --- Path 2: URL path (API Key auth or unauthenticated requests) ---
  // URL pattern: /api/{orgId}/devices[/{deviceId}]
  // split("/")[2] extracts the segment at position 2 (0-indexed after leading slash).
  const segment = new URL(request.url).pathname.split("/")[2];
  if (segment && segment !== "") {
    return { orgId: segment, method: "apikey" };
  }

  // --- Path 3: IP fallback ---
  // Applies to requests outside the /api/{orgId}/... pattern.
  return { orgId: request.headers.get("CF-Connecting-IP") ?? "unknown", method: "ip" };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Step 1: determine which organization this request belongs to.
    const { orgId, method } = extractOrgId(request);

    // Step 2: check the per-organization counter.
    // The binding maintains one counter per unique key value, so this single call
    // covers all organizations without any per-org configuration.
    let success: boolean;
    try {
      const result = await env.ORG_RATE_LIMITER.limit({ key: orgId });
      success = result.success;
    } catch {
      return new Response(
        JSON.stringify({ error: "Rate limiter unavailable", orgId }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Counter exhausted for this org. Return 429 and tell the client to retry
    // after the current window expires.
    if (!success) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded", orgId, method, retryAfter: 60 }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "60"
          }
        }
      );
    }

    // Step 3: request allowed. Annotate it with the resolved org ID and auth
    // method, then forward to the upstream API via the service binding.
    // Service bindings are zero-latency internal calls; no network hop occurs.
    const newHeaders = new Headers(request.headers);
    newHeaders.set("X-Org-Id", orgId);
    newHeaders.set("X-Auth-Method", method);

    const modifiedRequest = new Request(request, { headers: newHeaders });

    try {
      return await env.MOCK_API.fetch(modifiedRequest);
    } catch {
      return new Response(
        JSON.stringify({ error: "Upstream API unavailable", orgId }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  }
};
