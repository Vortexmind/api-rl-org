# API Shield JWT Validation Setup

This guide configures API Shield JWT validation for the device management API PoC.

## Prerequisites

- API Shield enabled on the zone (`humorous-jargon.sxpdemo.com`)
- The OpenAPI schema uploaded to Schema Validation (so endpoints appear in Endpoint Management)

## Files in this directory

| File | Purpose |
|------|---------|
| `private-key.pem` | Generated ES256 private key (keep secret; do not commit) |
| `public-key.pem` | Generated ES256 public key |
| `jwks.json` | Generated public key in JWKS format — upload this to API Shield |
| `generate-keys.js` | Node.js script to generate the key pair and JWKS |
| `generate-jwt.js` | Node.js script to create signed demo JWTs |

## Step 1: Generate the demo key pair

Run the key generator to create a fresh ES256 key pair and the JWKS file used by API Shield:

```bash
npm run jwt:keys
```

This writes three files locally:

- `jwt-demo/private-key.pem` — keep secret; used by `generate-jwt.js`
- `jwt-demo/public-key.pem` — public key
- `jwt-demo/jwks.json` — public key in JWKS format; upload this to API Shield

These files are ignored by Git and must not be committed.

## Step 2: Upload the OpenAPI schema (if not already done)

Upload `../workers/mock-api/openapi.yaml` via the Cloudflare dashboard:

Security > API Shield > Schema validation > Add validation

This populates Endpoint Management with the three device endpoints.

## Step 3: Create a Token Configuration

1. Go to **Security > API Shield > Settings** (or Security Settings > API abuse)
2. Under **Token configurations**, select **Configure tokens**
3. Add a name: `demo-jwt-config`
4. Token location:
   - Type: Header
   - Name: `Authorization`
   - Note: API Shield automatically handles the `Bearer ` prefix
5. Paste the contents of the freshly generated `jwt-demo/jwks.json` into the JWKS field
6. Save

## Step 4: Create a JWT Validation Rule

1. Go to **Security > API Shield > API Rules**
2. Select **Create rule**
3. Name: `device-api-jwt-validation`
4. Hostname: `api.humorous-jargon.sxpdemo.com`
5. Endpoints: select all three device endpoints (list, create, detail)
6. Token configuration: `demo-jwt-config`
7. Enforcement mode:
   - Select **Ignore** (not "Mark as non-compliant")
   - This preserves dual-auth: requests with a JWT are validated; requests without a JWT (API Key auth) are allowed through
8. Action for non-compliant requests: `block`
   - This blocks requests that present an invalid JWT (expired, tampered, bad signature)
9. Save

## Step 5: Generate a test JWT

```bash
node generate-jwt.js org-alpha
```

Copy the output token and use it in requests:

```bash
curl -H "Authorization: Bearer <token>" \
  https://api.humorous-jargon.sxpdemo.com/api/org-alpha/devices
```

## Step 6: Test the dual-auth flow

### Valid JWT (should succeed)
```bash
TOKEN=$(node generate-jwt.js org-alpha | grep '^ey' | head -1)
curl -H "Authorization: Bearer $TOKEN" \
  https://api.humorous-jargon.sxpdemo.com/api/org-alpha/devices
```

### Invalid JWT (should be blocked at edge)
```bash
# Tamper with the payload
curl -H "Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkZW1vLWlzc3VlciJ9.INVALID" \
  https://api.humorous-jargon.sxpdemo.com/api/org-alpha/devices
# Expected: 403 from API Shield (JWT validation failed)
```

### API Key auth (no JWT, should succeed)
```bash
curl -H "X-API-Key: demo-key" \
  https://api.humorous-jargon.sxpdemo.com/api/org-alpha/devices
```

## Architecture with API Shield

```
Client request
    |
    v
Cloudflare Edge (API Shield)
    - If Authorization header present:
      - Validate JWT signature against JWKS
      - Check expiry (iat, exp, nbf)
      - Block if invalid
    - If no Authorization header:
      - Pass through (dual-auth: falls back to API Key)
    |
    v
api-rate-limiter Worker
    - Decode JWT payload (trusts it's valid)
    - Extract organizationId claim
    - Apply per-org rate limit
    |
    v
api-mock-backend Worker
```

## Key points

- API Shield validates JWTs **before** the Worker runs
- The Worker still decodes JWTs to extract `organizationId` for rate-limit keying
- Invalid JWTs are blocked at the edge with a 403, never reaching the rate limiter
- API Key requests (no JWT) continue to work because the rule is set to "Ignore" missing tokens
- The JWKS only contains public keys; `private-key.pem` never leaves this directory
