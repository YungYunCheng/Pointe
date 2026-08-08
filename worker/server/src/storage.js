import fs from "node:fs";
import path from "node:path";
import { fileHash } from "./crypto.js";

/* ============================================================
   File storage

   Local disk in development, S3-compatible object storage in
   production. Same interface either way, so nothing that stores a
   file has to know which.

   This matters more than it looks. The volume holds two things that
   cannot be recreated: the photographs behind every deposit
   deduction, and the agreement files a lawyer approved. On local
   disk they do not survive a container being replaced on another
   host.
   ============================================================ */

const LOCAL_ROOT = process.env.UPLOAD_DIR || "/app/data/uploads";
const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION || "us-west-2";
const ENDPOINT = process.env.S3_ENDPOINT;          // set for R2, MinIO, Spaces

let s3 = null;
let s3Checked = false;

async function getS3() {
  if (s3Checked) return s3;
  s3Checked = true;
  if (!BUCKET) return null;
  try {
    const { S3Client } = await import("@aws-sdk/client-s3");
    s3 = new S3Client({
      region: REGION,
      ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
      credentials: process.env.S3_ACCESS_KEY_ID ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      } : undefined,
    });
    console.log(`[storage] object storage: ${BUCKET}${ENDPOINT ? ` at ${ENDPOINT}` : ""}`);
  } catch (e) {
    console.error("[storage] S3 client unavailable:", e.message);
    s3 = null;
  }
  return s3;
}

export function storageMode() {
  return BUCKET ? "s3" : "local";
}

/** Writes and returns the key plus the hash. The hash is what makes "this is
 *  the file that was uploaded" checkable later. */
export async function put(key, buffer, contentType) {
  const hash = fileHash(buffer);
  const client = await getS3();

  if (client) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: buffer,
      ContentType: contentType || "application/octet-stream",
      ChecksumSHA256: Buffer.from(hash, "hex").toString("base64"),
      // Evidence and agreements are written once and never edited. Versioning
      // on the bucket turns an accidental overwrite into something recoverable.
      Metadata: { sha256: hash },
    }));
    return { key, sha256: hash, size: buffer.length, mode: "s3" };
  }

  const full = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
  return { key, sha256: hash, size: buffer.length, mode: "local" };
}

export async function get(key) {
  const client = await getS3();
  if (client) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const c of out.Body) chunks.push(c);
    return Buffer.concat(chunks);
  }
  const full = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

export async function stream(key, res, { filename, contentType, sha256 } = {}) {
  const client = await getS3();
  if (contentType) res.setHeader("Content-Type", contentType);
  if (filename) res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  if (sha256) res.setHeader("X-Content-SHA256", sha256);

  if (client) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const out = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    out.Body.pipe(res);
    return true;
  }
  const full = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(full)) return false;
  fs.createReadStream(full).pipe(res);
  return true;
}

export async function exists(key) {
  const client = await getS3();
  if (client) {
    try {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
      await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return true;
    } catch { return false; }
  }
  return fs.existsSync(path.join(LOCAL_ROOT, key));
}

/* Nothing deletes evidence or agreements. There is no remove() here on
   purpose: the retention job removes database rows, not the files behind a
   deduction somebody may still have to defend. */

export async function health() {
  const mode = storageMode();
  if (mode === "local") {
    try {
      fs.mkdirSync(LOCAL_ROOT, { recursive: true });
      fs.accessSync(LOCAL_ROOT, fs.constants.W_OK);
      return { mode, ok: true, path: LOCAL_ROOT,
        warning: "Local disk does not survive a container being replaced. Evidence and agreements belong in object storage before production." };
    } catch (e) { return { mode, ok: false, error: e.message }; }
  }
  const client = await getS3();
  return { mode, ok: !!client, bucket: BUCKET, endpoint: ENDPOINT ?? null };
}
