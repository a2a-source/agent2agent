import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
mkdirSync("var/keys", { recursive: true, mode: 0o700 });
if (
  existsSync("var/keys/private.pem") ||
  existsSync("var/keys/public.pem") ||
  existsSync("var/admin-token")
)
  throw Error(
    "Initialization refused: existing credentials must not be overwritten.",
  );
const keys = generateKeyPairSync("rsa", {
  modulusLength: 3072,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
writeFileSync("var/keys/private.pem", keys.privateKey, {
  mode: 0o600,
  flag: "wx",
});
writeFileSync("var/keys/public.pem", keys.publicKey, {
  mode: 0o600,
  flag: "wx",
});
writeFileSync("var/admin-token", randomBytes(32).toString("hex"), {
  mode: 0o600,
  flag: "wx",
});
console.log(
  "Created local RSA key pair and var/admin-token. Back up keys separately from the SQLite database.",
);
