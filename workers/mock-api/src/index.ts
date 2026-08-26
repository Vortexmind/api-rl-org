/*
 * api-mock-backend: simulated device management API
 *
 * This Worker is the internal upstream called exclusively via service binding
 * from api-rate-limiter. It is never exposed directly to the internet.
 *
 * Its purpose in this PoC is to stand in for a real API backend, so the
 * customer can observe end-to-end request flow, per-organization routing,
 * and rate limiting behaviour without connecting to a live system.
 *
 * Endpoints:
 *   GET  /api/{orgId}/devices            List all devices for an organization
 *   POST /api/{orgId}/devices            Register a new device (returns mock)
 *   GET  /api/{orgId}/devices/{deviceId} Get a single device by ID
 *
 * Response headers added by this Worker:
 *   X-Org-Id       The resolved organization ID (echoed from X-Org-Id request
 *                  header set by the rate limiter, or parsed from the URL path)
 *   X-Mock-Endpoint Identifies which route handled the request — useful for
 *                  confirming routing during a demo or debugging session
 */

/**
 * Represents a single managed device belonging to an organization.
 * orgId is populated at response time from the request context rather
 * than stored in MOCK_DEVICES, so the same device records serve all orgs.
 */
export interface Device {
  deviceId: string;
  model: string;
  status: string;
  orgId: string;
}

export interface Env {
  // No bindings required for mock-api
}

/**
 * Static device catalogue shared across all organizations in this PoC.
 * orgId is intentionally left empty here; it is set on each response from
 * the request's resolved organization ID, so the same three records
 * appear correctly scoped regardless of which org is queried.
 *
 * In a real implementation this would be a database query filtered by orgId.
 */
const MOCK_DEVICES: Device[] = [
  { deviceId: "DL-001", model: "DL-AXIST", status: "online", orgId: "" },
  { deviceId: "DL-002", model: "DL-Gryphon", status: "offline", orgId: "" },
  { deviceId: "DL-003", model: "DL-Memor", status: "maintenance", orgId: "" }
];

/**
 * Main request handler.
 *
 * Routing is implemented with two regex matches against the URL path.
 * Order matters: the more specific device-detail pattern is checked after
 * the devices-list pattern because the list pattern anchors on the end of
 * the path (no trailing segment).
 *
 * org ID resolution:
 *   The rate-limiter sets X-Org-Id on every forwarded request after resolving
 *   the org from the JWT claim or URL path. This Worker reads that header and
 *   prefers it over the URL path segment. Both values should agree in normal
 *   operation; the fallback to URL parsing is a safety net for direct calls.
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Prefer the org ID forwarded by the rate-limiter over re-parsing the URL.
    // The rate-limiter has already resolved JWT vs. path vs. IP priority.
    const orgIdFromHeader = request.headers.get("X-Org-Id");

    // Route: /api/{orgId}/devices  (list + create)
    // Anchored at both ends; does not match if a deviceId segment is present.
    const devicesMatch = path.match(/^\/api\/([^\/]+)\/devices$/);
    if (devicesMatch) {
      const parsedOrgId = devicesMatch[1];
      const orgId = orgIdFromHeader ?? parsedOrgId;

      if (request.method === "GET") {
        const devices = MOCK_DEVICES.map(d => ({ ...d, orgId }));
        return new Response(JSON.stringify(devices), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Org-Id": orgId,
            "X-Mock-Endpoint": "devices-list"
          }
        });
      }

      if (request.method === "POST") {
        const newDevice: Device = {
          deviceId: "DL-NEW",
          model: "DL-Generic",
          status: "provisioning",
          orgId
        };
        return new Response(JSON.stringify(newDevice), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            "X-Org-Id": orgId,
            "X-Mock-Endpoint": "device-create"
          }
        });
      }
    }

    // Route: /api/{orgId}/devices/{deviceId}  (single device lookup)
    const deviceDetailMatch = path.match(/^\/api\/([^\/]+)\/devices\/([^\/]+)$/);
    if (deviceDetailMatch && request.method === "GET") {
      const parsedOrgId = deviceDetailMatch[1];
      const orgId = orgIdFromHeader ?? parsedOrgId;
      const deviceId = deviceDetailMatch[2];
      // Return 404 if the deviceId is not in the mock catalogue.
      // Valid IDs for this PoC: DL-001, DL-002, DL-003.
      const device = MOCK_DEVICES.find(d => d.deviceId === deviceId);

      if (!device) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ ...device, orgId }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Org-Id": orgId,
          "X-Mock-Endpoint": "device-detail"
        }
      });
    }

    // Default 404
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
};
