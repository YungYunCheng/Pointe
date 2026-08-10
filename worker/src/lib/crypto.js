/* ============================================================
   Password hashing

   Secure password stretching is intentionally expensive. Cloudflare's Free
   plan allows only 10 ms of CPU per Worker request, so PBKDF2, scrypt and
   Argon2 do not belong inside this runtime. Supabase PostgreSQL already has
   pgcrypto: bcrypt runs there and the Worker receives only the finished hash.

   Older hashes are not silently weakened to fit the edge CPU budget. Those
   accounts use the one-time reset flow and are upgraded to bcrypt-pgcrypto.
   ============================================================ */

const BCRYPT_COST = 12;

const bytesToHex = (b) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hashPassword(password, sql) {
  if (!sql) throw new Error("PASSWORD_DB_REQUIRED");

  // Password stretching runs in PostgreSQL rather than in the Worker. The
  // Workers Free plan allows only 10 ms of CPU per request; a secure PBKDF2
  // cost cannot fit inside that budget and is terminated with Error 1102.
  // Supabase already provides pgcrypto, so bcrypt can stay deliberately slow
  // without consuming Worker CPU.
  const [row] = await sql`
    SELECT extensions.crypt(
      ${password}, extensions.gen_salt('bf', ${BCRYPT_COST})
    ) AS hash`;
  if (!row?.hash) throw new Error("PASSWORD_HASH_FAILED");

  return {
    algo: "bcrypt-pgcrypto",
    salt: "",
    hash: row.hash,
    params: JSON.stringify({ cost: BCRYPT_COST }),
  };
}

export async function verifyPassword(password, record, sql) {
  const algo = record?.password_algo ?? record?.algo;
  const stored = record?.password_hash ?? record?.hash;
  if (!stored) return false;

  if (algo === "bcrypt-pgcrypto") {
    if (!sql) throw new Error("PASSWORD_DB_REQUIRED");
    const [row] = await sql`
      SELECT extensions.crypt(${password}, ${stored}) = ${stored} AS ok`;
    return !!row?.ok;
  }

  // Hashes made by the old container or the first Worker build cannot be
  // checked within the Free-plan CPU budget. A one-time reset upgrades them.
  if (["argon2id", "scrypt", "pbkdf2-sha512"].includes(algo))
    throw Object.assign(new Error("PASSWORD_NEEDS_RESET"), {
      status: 409, code: "PASSWORD_NEEDS_RESET",
      detail: "This password was set on the old server and cannot be checked here. Use the reset link.",
    });

  return false;
}

/** True when a hash was made under something this runtime cannot verify. The
 *  next successful reset upgrades it. */
export const needsRehash = (record) =>
  (record?.password_algo ?? record?.algo) !== "bcrypt-pgcrypto";

export const randToken = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToHex(await crypto.subtle.digest("SHA-256", data));
}

export const fileHash = sha256;
