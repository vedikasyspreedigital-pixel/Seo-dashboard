import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashing via Node's built-in crypto.scrypt -- no new dependency
// (no bcrypt/bcryptjs), matching this codebase's existing preference for
// hand-rolling something this small over pulling in a package (see
// app.ts's CORS middleware, which avoids the `cors` package the same way).
// Format stored in User.passwordHash: "<salt-hex>:<derivedKey-hex>".

const KEY_LENGTH = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(plain, salt, KEY_LENGTH);
  return `${salt}:${derivedKey.toString("hex")}`;
}

export function verifyPassword(plain: string, storedHash: string): boolean {
  const [salt, keyHex] = storedHash.split(":");
  if (!salt || !keyHex) return false;
  const derivedKey = scryptSync(plain, salt, KEY_LENGTH);
  const storedKey = Buffer.from(keyHex, "hex");
  if (derivedKey.length !== storedKey.length) return false;
  return timingSafeEqual(derivedKey, storedKey);
}
