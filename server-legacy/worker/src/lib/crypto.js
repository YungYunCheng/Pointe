/* ============================================================
   Password hashing on Workers

   Argon2id does not run here. It is a native module, and Workers
   has no native modules — this is not a configuration problem and
   there is no flag for it.

   The options are PBKDF2 through Web Crypto, which is built in and
   fast because it runs in the runtime rather than in JavaScript, or
   a pure-JS scrypt, which works and takes hundreds of milliseconds
   of CPU that Workers bills for.

   PBKDF2-SHA512 at 600,000 iterations is what OWASP recommends
   where Argon2 is unavailable. It is weaker than Argon2id against
   an attacker with GPUs, and that is a real trade rather than an
   equivalent swap. It is the right one here because the alternative
   is not Argon2 — the alternative is scrypt in JavaScript, which is
   slower for the user and no stronger.

   The algorithm is stored with every hash, so nothing has to be
   reset when this changes and an existing scrypt hash from the
   container still verifies.
   ============================================================ */

const PBKDF2 = { iterations: 600_000, hash: "SHA-512", keyLength: 64 };

const bytesToHex = (b) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hexToBytes = (h) =>
  new Uint8Array(h.match(/.{1,2}/g)?.map((x) => parseInt(x, 16)) ?? []);

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2.iterations, hash: PBKDF2.hash },
    key, PBKDF2.keyLength * 8);

  return {
    algo: "pbkdf2-sha512",
    salt: bytesToHex(salt),
    hash: bytesToHex(bits),
    params: JSON.stringify(PBKDF2),
  };
}

export async function verifyPassword(password, record) {
  const algo = record?.password_algo ?? record?.algo;
  const stored = record?.password_hash ?? record?.hash;
  const salt = record?.password_salt ?? record?.salt ?? "";
  if (!stored) return false;

  if (algo === "pbkdf2-sha512") {
    const params = record?.password_params ? JSON.parse(record.password_params) : PBKDF2;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: hexToBytes(salt),
        iterations: params.iterations, hash: params.hash },
      key, (params.keyLength ?? 64) * 8);
    return timingSafeEqual(bytesToHex(bits), stored);
  }

  // A hash made by the container, under Argon2id or scrypt. Neither can be
  // verified here, so those accounts have to go through a reset once. Better
  // to say so than to fail as though the password were wrong.
  if (algo === "argon2id" || algo === "scrypt")
    throw Object.assign(new Error("PASSWORD_NEEDS_RESET"), {
      status: 409, code: "PASSWORD_NEEDS_RESET",
      detail: "This password was set on the old server and cannot be checked here. Use the reset link.",
    });

  return false;
}

/** True when a hash was made under something this runtime cannot verify. The
 *  next successful reset upgrades it. */
export const needsRehash = (record) =>
  (record?.password_algo ?? record?.algo) !== "pbkdf2-sha512";

/** Constant time. A comparison that returns early on the first wrong
 *  character tells an attacker how much of it was right. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const randToken = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

export const fileHash = sha256;
