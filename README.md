# API Rate Limiting PoC

> Provided as-is for educational and reference purposes. See [LICENSE](LICENSE) for details.


A Cloudflare Workers proof of concept  demonstrating per-organization rate limiting on API endpoints. The PoC supports both JWT authentication (with `organizationId` in a claim) and API Key authentication (with `organizationId` in the URL path).

## Architecture

```mermaid
flowchart LR
    Client([Client]) -->|HTTPS /api/{orgId}/...| Edge

    subgraph Cloudflare["Cloudflare Edge"]
        Edge -->|Authorization: Bearer JWT| APIShield["API Shield<br/>JWT validation"]
        Edge -->|X-API-Key or no auth| RateLimiter
        APIShield -->|valid JWT| RateLimiter
        APIShield -.->|invalid JWT: 403| Edge
    end

    RateLimiter["api-rate-limiter Worker"] -->|limit(orgId)| RateLimitBinding[(Workers Rate<br/>Limiting binding)]
    RateLimitBinding -->|success| RateLimiter
    RateLimitBinding -.->|429 Too Many Requests| Client

    RateLimiter -->|proxy via MOCK_API<br/>service binding| MockAPI["api-mock-backend Worker"]
    MockAPI -->|JSON response| RateLimiter
    RateLimiter -->|200 OK| Edge
    Edge --> Client

    style APIShield fill:#f9f,stroke:#333
    style RateLimitBinding fill:#bbf,stroke:#333
```


## Setup and Testing

1. Install dependencies:

   ```bash
   npm install
   ```

2. Generate the local JWT demo keys and a sample token:

   ```bash
   npm run jwt -- org-alpha
   ```

   This creates `jwt-demo/private-key.pem`, `jwt-demo/public-key.pem` and `jwt-demo/jwks.json` if they do not already exist.

3. Authenticate Wrangler with your Cloudflare account:

   ```bash
   wrangler login
   ```

   Alternatively, set `account_id` in each `wrangler.toml`.

4. Deploy the Workers as described in the Deployment section below.

5. Run the automated tests:

   ```bash
   npm test
   ```

   By default the tests target `api.example.com`. Override the domain with:

   ```bash
   DOMAIN=your-domain.com npm test
   ```

6. The generated `.pem` files and `jwks.json` are local artifacts and are ignored by Git.

## Prerequisites

- Node.js 18 or later
- Wrangler CLI (`npm install -g wrangler`)
- A Cloudflare account with Workers and Rate Limiting enabled
- Authenticated with Wrangler (`wrangler login`)

## Installation

```bash
npm install
```

## Deployment

Deploy the mock API first, then the rate limiter. The order matters because the rate limiter references the mock API via a service binding.

The rate limiter is configured to serve on the custom domain `api.example.com` via the `routes` setting in `wrangler.toml`:

```toml
routes = [
  { pattern = "api.example.com", custom_domain = true }
]
```

To deploy both workers in one command:

```bash
npm run deploy
```

Or deploy individually:

### Step 1: Deploy the mock API

```bash
npm run deploy:mock
```

This deploys `api-mock-backend` as a Cloudflare Worker. It is only accessible via the service binding from the rate limiter.

### Step 2: Deploy the rate limiter

```bash
npm run deploy:limiter
```

This deploys `api-rate-limiter`, which includes:
- A service binding to `api-mock-backend`
- A rate limit binding (`ORG_RATE_LIMITER`) configured in `wrangler.toml`
- A custom domain route for `api.example.com`

### Why order matters

The `api-rate-limiter` Worker declares a service binding to `api-mock-backend` in its `wrangler.toml`:

```toml
[[services]]
binding = "MOCK_API"
service = "api-mock-backend"
```

Wrangler validates that the target service exists at deploy time, so `api-mock-backend` must be deployed before `api-rate-limiter`.

## Automated Testing

Run all demo scenarios automatically with the included test script:

```bash
npm test
```

Or run the script directly:

```bash
./run-tests.sh
```

The script runs three scenarios with colorized output and pass/fail indicators. To test against a different domain:

```bash
DOMAIN=your-domain.com ./run-tests.sh
```

## Demo Scenarios

Replace `api.example.com` with your own domain if deploying to a different zone.

### Scenario A: API Key auth, per-organization throttling

With API Key authentication, the organization ID comes from the URL path. All requests with the same `orgId` segment share a single rate limit bucket.

```bash
# These all count against org-alpha
for i in {1..12}; do
  curl -s -w "\nHTTP %{http_code}\n" https://api.example.com/api/org-alpha/devices
done
# The 11th and 12th requests should return 429
```

### Scenario B: JWT auth, per-organization throttling

With JWT authentication, the organization ID is read from the `organizationId` claim in the token payload. API Shield validates the JWT signature, expiry and integrity at the Cloudflare edge before the request reaches the Worker; the Worker only decodes the payload to extract the claim.

Generate a test JWT with an `organizationId` claim. First generate the demo keys, then create a signed ES256 token for `org-beta`:

```bash
npm run jwt -- org-beta
JWT=$(npm run jwt -- org-beta | grep '^ey' | head -1)
```

Then send requests with the signed JWT:

```bash
for i in {1..12}; do curl -s -w "\nHTTP %{http_code}\n" -H "Authorization: Bearer $JWT" https://api.example.com/api/org-beta/devices; done
# The 11th and 12th requests should return 429
```

### Scenario C: Cross-organization isolation

Rate limits are scoped per organization. A 429 for one org does not affect another.

```bash
# Exhaust org-alpha's quota
for i in {1..12}; do
  curl -s -w "\nHTTP %{http_code}\n" https://api.example.com/api/org-alpha/devices > /dev/null
done

# Immediately request as org-beta: should return 200
curl -s -w "\nHTTP %{http_code}\n" https://api.example.com/api/org-beta/devices
```

## Configuration

The rate limit is configured in `workers/rate-limiter/wrangler.toml`:

```toml
[[ratelimits]]
name = "ORG_RATE_LIMITER"
namespace_id = "1001"

  [ratelimits.simple]
  limit = 10
  period = 60
```

- `limit`: Number of allowed requests per period (default: 10)
- `period`: Time window in seconds (default: 60)

Adjust these values to match your desired rate limit policy. The `namespace_id` must be unique within your account. Changes require redeployment with `npm run deploy:limiter`.

## Production Notes

- **JWT validation**: API Shield validates the JWT signature, expiry and integrity at the Cloudflare edge before the request reaches the Worker. The Worker only decodes the payload to extract the `organizationId` claim.

- **No-code alternative**: For the JWT authentication path, Cloudflare's native WAF Rate Limiting supports a `JWT claim of` characteristic. This lets you enforce per-organization rate limits without writing a custom Worker. The custom Worker approach in this PoC is preferred when you need fine-grained control over the extraction logic or when supporting both JWT and API Key auth methods together.

- **Rate limit scope**: The current binding uses a simple counter per key (`orgId`). For more advanced policies (e.g., different limits per tier), you could introduce multiple rate limit bindings or augment the key with additional dimensions.

## Files Overview

| File | Purpose |
|------|---------|
| `package.json` | Project metadata and npm scripts for deployment and testing |
| `tsconfig.json` | TypeScript configuration shared by both Workers |
| `run-tests.sh` | Automated test runner for all three demo scenarios |
| `workers/rate-limiter/wrangler.toml` | Wrangler config for the public-facing rate limiter Worker, including service binding, rate limit binding, and custom domain route |
| `workers/rate-limiter/src/index.ts` | Rate limiter Worker source: extracts `orgId` from JWT or path, enforces rate limit, proxies to mock API |
| `workers/mock-api/wrangler.toml` | Wrangler config for the internal mock API Worker |
| `workers/mock-api/src/index.ts` | Mock API Worker source: simulates endpoints (`GET /api/{orgId}/devices`, `POST /api/{orgId}/devices`, `GET /api/{orgId}/devices/{deviceId}`) |
