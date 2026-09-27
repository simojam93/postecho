import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for the few secrets the owner pastes into Settings (the
 * X API bearer token, 2026-09-24), so a copy of the database alone never
 * holds a working key. AES-256-GCM with a key derived from SESSION_SECRET —
 * the app's one server-only secret — so nothing new needs configuring. A
 * rotated SESSION_SECRET makes a stored secret unreadable: openSecret then
 * returns null and Settings asks for the key again.
 */
const VERSION = "v1";

function keyFor(secret: string | undefined): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", secret, "postecho-settings", "secret-box-v1", 32));
}

/** Seals `plain`; throws when SESSION_SECRET is missing (the route answers 500, nothing is stored). */
export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFor(env.SESSION_SECRET);
  if (!key) throw new Error("SESSION_SECRET is missing or shorter than 32 characters");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** The plain secret, or null for "", a foreign format, a tampered value or a different SESSION_SECRET. */
export function openSecret(sealed: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sealed) return null;
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  const key = keyFor(env.SESSION_SECRET);
  if (!key) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
