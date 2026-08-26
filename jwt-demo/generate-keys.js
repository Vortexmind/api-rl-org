/**
 * JWT Demo Key Generator
 *
 * Usage:
 *   node generate-keys.js
 *
 * Generates a fresh ES256 key pair and writes:
 *   - jwt-demo/private-key.pem
 *   - jwt-demo/public-key.pem
 *   - jwt-demo/jwks.json
 *
 * The JWKS is the public key material uploaded to API Shield for JWT validation.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRIVATE_KEY_PATH = path.join(__dirname, "private-key.pem");
const PUBLIC_KEY_PATH = path.join(__dirname, "public-key.pem");
const JWKS_PATH = path.join(__dirname, "jwks.json");
const KEY_ID = "demo-key-1";

function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
  fs.chmodSync(PRIVATE_KEY_PATH, 0o600);
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);

  const publicJwk = crypto.createPublicKey(publicKey).export({ format: "jwk" });

  const jwks = {
    keys: [
      {
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
        kid: KEY_ID,
        use: "sig",
        alg: "ES256",
      },
    ],
  };

  fs.writeFileSync(JWKS_PATH, JSON.stringify(jwks, null, 2));

  console.log("Generated ES256 key pair and JWKS:");
  console.log(`  Private key: ${PRIVATE_KEY_PATH}`);
  console.log(`  Public key:  ${PUBLIC_KEY_PATH}`);
  console.log(`  JWKS:        ${JWKS_PATH}`);
}

main();
