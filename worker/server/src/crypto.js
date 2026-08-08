import crypto from "node:crypto";
import { promisify } from "node:util";

/* ============================================================
   Password hashing

   Argon2id where the native module is available, scrypt otherwise.
   Both are stored with their algorithm and parameters, so a hash
   made under one is still verifiable after a switch — nobody has to
   reset every password to change algorithm.

   Argon2id is the current recommendation because it resists GPU and
   side-channel attacks in a way scrypt does not. The parameters below
   target roughly 100ms on a modest server: slow enough to make
   offline guessing expensive, fast enough that a login does not feel
   broken.
   ============================================================ */

const ARGON_OPTIONS = {
  type: 2,                 // argon2id
  memoryCost: 19456,       // 19 MiB, the OWASP baseline
  timeCost: 2,
  parallelism: 1,
};

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scryptAsync = promisify(crypto.scrypt);

let argon2 = null;
let argonChecked = false;

/** Loaded lazily. The native build fails on some platforms, and a password
 *  system that cannot start is worse than one using the older algorithm. */
async function getArgon() {
  if (argonChecked) return argon2;
  argonChecked = true;
  try {
    argon2 = (await import("argon2")).default;
    console.log("[crypto] argon2id available");
  } catch {
    console.warn("[crypto] argon2 unavailable, falling back to scrypt");
    argon2 = null;
  }
  return argon2;
}

export async function hashPassword(password) {
  const a = await getArgon();
  if (a) {
    const hash = await a.hash(password, ARGON_OPTIONS);
    return { algo: "argon2id", salt: "", hash, params: JSON.stringify(ARGON_OPTIONS) };
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return { algo: "scrypt", salt, hash: derived.toString("hex"),
           params: JSON.stringify(SCRYPT) };
}

export async function verifyPassword(password, record) {
  const algo = record?.password_algo ?? record?.algo;
  const hash = record?.password_hash ?? record?.hash;
  const salt = record?.password_salt ?? record?.salt ?? "";
  if (!hash) return false;

  if (algo === "argon2id") {
    const a = await getArgon();
    if (!a) return false;
    try { return await a.verify(hash, password); } catch { return false; }
  }

  const params = record?.password_params ? JSON.parse(record.password_params) : SCRYPT;
  const derived = await scryptAsync(password, salt, params.keylen ?? 64, params);
  const expected = Buffer.from(hash, "hex");
  // Constant time, so a wrong password takes as long to reject as a right one
  // takes to accept.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** True when a hash was made under an older algorithm. The next successful
 *  login is the right moment to upgrade it: the plaintext is in hand, and the
 *  user notices nothing. */
export function needsRehash(record) {
  return (record?.password_algo ?? record?.algo) !== "argon2id";
}

export const randToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const fileHash = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
