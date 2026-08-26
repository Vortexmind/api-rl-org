/**
 * JWT Demo Generator
 *
 * Usage:
 *   node generate-jwt.js <organization-id>
 *
 * Example:
 *   node generate-jwt.js org-alpha
 *   node generate-jwt.js org-beta
 *
 * Outputs a signed JWT (ES256) with the following claims:
 *   - iss: "demo-issuer"
 *   - sub: "demo-user"
 *   - organizationId: <provided-org-id>
 *   - iat: now
 *   - exp: now + 1 hour
 *
 * The corresponding JWKS (jwt-demo/jwks.json) must be uploaded to
 * API Shield > Token configurations for JWT validation at the edge.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRIVATE_KEY_PATH = path.join(__dirname, "private-key.pem");

// Base64URL encode (no padding, no +/)
function base64url(source) {
  return source.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64urlDecode(base64urlString) {
  const base64 = base64urlString.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(base64 + padding, "base64");
}

function sign(data, privateKey) {
  const signer = crypto.createSign("SHA256");
  signer.update(data);
  signer.end();
  const der = signer.sign(privateKey); // Buffer containing DER-encoded ECDSA signature

  // Parse DER SEQUENCE: 0x30 <total-len> 0x02 <r-len> <r-bytes> 0x02 <s-len> <s-bytes>
  // byte 0: 0x30 (SEQUENCE tag)
  // byte 1: total length
  // byte 2: 0x02 (INTEGER tag for r)
  // byte 3: r length
  const rLen = der[3];
  const rBytes = der.slice(4, 4 + rLen);

  // byte (4+rLen): 0x02 (INTEGER tag for s)
  // byte (4+rLen+1): s length
  const sLen = der[4 + rLen + 1];
  const sBytes = der.slice(4 + rLen + 2, 4 + rLen + 2 + sLen);

  // Strip leading 0x00 padding byte that DER adds when the high bit is set
  const rStripped = rBytes[0] === 0x00 ? rBytes.slice(1) : rBytes;
  const sStripped = sBytes[0] === 0x00 ? sBytes.slice(1) : sBytes;

  // Zero-pad each component to exactly 32 bytes (right-aligned copy)
  const rPadded = Buffer.alloc(32);
  rStripped.copy(rPadded, 32 - rStripped.length);

  const sPadded = Buffer.alloc(32);
  sStripped.copy(sPadded, 32 - sStripped.length);

  // Concatenate to produce the 64-byte raw ES256 signature
  const rawSig = Buffer.concat([rPadded, sPadded]);
  return base64url(rawSig.toString("base64"));
}

function generateJWT(orgId) {
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");

  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: "demo-key-1",
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "demo-issuer",
    sub: "demo-user",
    organizationId: orgId,
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const encodedHeader = base64url(
    Buffer.from(JSON.stringify(header)).toString("base64")
  );
  const encodedPayload = base64url(
    Buffer.from(JSON.stringify(payload)).toString("base64")
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}

function main() {
  const orgId = process.argv[2];

  if (!orgId) {
    console.error("Usage: node generate-jwt.js <organization-id>");
    console.error("Example: node generate-jwt.js org-alpha");
    process.exit(1);
  }

  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error("Error: private-key.pem not found.");
    console.error("Please generate demo keys first by running:");
    console.error("  npm run jwt:keys");
    process.exit(1);
  }

  const token = generateJWT(orgId);
  console.log("\n=== Generated JWT ===");
  console.log(token);
  console.log("\n=== Decoded Header ===");
  console.log(JSON.stringify(JSON.parse(base64urlDecode(token.split(".")[0]).toString()), null, 2));
  console.log("\n=== Decoded Payload ===");
  console.log(JSON.stringify(JSON.parse(base64urlDecode(token.split(".")[1]).toString()), null, 2));
  console.log("\n=== curl example ===");
  console.log(`curl -H "Authorization: Bearer ${token}" https://api.humorous-jargon.sxpdemo.com/api/${orgId}/devices`);
}

main();
