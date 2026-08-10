import { db, nowISO } from "./db.js";
import { fileHash } from "./crypto.js";
import * as storage from "./storage.js";

/* ============================================================
   Applying signatures to a PDF, and the certificate that goes
   with it.

   Two rules run through this.

   The source file is never modified. A signed agreement is a new
   file; the version a lawyer approved stays exactly as uploaded,
   and both hashes are recorded so the pair can be compared later.

   The marks are drawn on top. Nothing in the document text moves,
   reflows or is regenerated — a signature that shifted a clause
   onto the next page would be worse than no signature at all.
   ============================================================ */

let pdfLib = null;
async function lib() {
  if (!pdfLib) pdfLib = await import("pdf-lib");
  return pdfLib;
}

/** Reads the page count and dimensions so fields can be placed against real
 *  coordinates rather than guessed ones. */
export async function inspect(buffer) {
  const { PDFDocument } = await lib();
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return {
    pages: doc.getPageCount(),
    sizes: doc.getPages().map((p, i) => {
      const { width, height } = p.getSize();
      return { page: i + 1, width, height };
    }),
  };
}

const dataUrlToBytes = (dataUrl) => {
  const b64 = String(dataUrl).split(",")[1] ?? "";
  return Buffer.from(b64, "base64");
};

/**
 * Overlays every filled field onto a copy of the source.
 *
 * Positions are in PDF points from the bottom-left, which is how the PDF
 * itself measures. Storing them any other way means converting twice and
 * getting it wrong once.
 */
export async function applySignatures(sourceBuffer, fields, parties) {
  const { PDFDocument, StandardFonts, rgb } = await lib();
  const doc = await PDFDocument.load(sourceBuffer, { ignoreEncryption: true });
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const byParty = Object.fromEntries(parties.map((p) => [p.id, p]));

  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const party = byParty[f.party_id];

    if (f.kind === "signature" || f.kind === "initials") {
      const img = party?.signature_image;
      if (!img) continue;

      if (String(img).startsWith("data:image")) {
        const bytes = dataUrlToBytes(img);
        const embedded = String(img).includes("image/jpeg")
          ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        // Fit inside the box without distorting. A stretched signature looks
        // forged even when it is not.
        const scale = Math.min(f.width / embedded.width, f.height / embedded.height);
        const w = embedded.width * scale, h = embedded.height * scale;
        page.drawImage(embedded, { x: f.x + (f.width - w) / 2,
          y: f.y + (f.height - h) / 2, width: w, height: h });
      } else {
        // A typed name, drawn in an italic face so it reads as a signature
        // rather than as body text somebody added.
        page.drawText(String(img).slice(0, 60), {
          x: f.x + 4, y: f.y + f.height * 0.35,
          size: Math.min(20, f.height * 0.5), font: italic, color: rgb(0.05, 0.1, 0.2) });
      }

      // The line beneath and the attribution. Without a name under the mark,
      // a signature on page nine says nothing about who made it.
      page.drawLine({ start: { x: f.x, y: f.y + 2 }, end: { x: f.x + f.width, y: f.y + 2 },
        thickness: 0.5, color: rgb(0.55, 0.6, 0.65) });
      page.drawText(`${party?.full_name ?? ""}  ·  ${String(party?.signed_at ?? "").slice(0, 16).replace("T", " ")}`,
        { x: f.x, y: f.y - 9, size: 6.5, font, color: rgb(0.45, 0.5, 0.55) });
      continue;
    }

    if (!f.value) continue;
    if (f.kind === "checkbox") {
      if (f.value === "true" || f.value === "1")
        page.drawText("X", { x: f.x + 2, y: f.y + 2, size: 12, font,
          color: rgb(0.05, 0.1, 0.2) });
      continue;
    }
    page.drawText(String(f.value).slice(0, 120), {
      x: f.x + 2, y: f.y + f.height * 0.3,
      size: Math.min(11, f.height * 0.55), font, color: rgb(0.05, 0.1, 0.2) });
  }

  return Buffer.from(await doc.save());
}

/**
 * The certificate of completion, appended as extra pages.
 *
 * This is the part that actually matters. A drawn squiggle proves very little;
 * a record of who opened the document, when, from what address, that they
 * consented to sign electronically, and that the file hash before and after
 * accounts for every change — that is what answers a challenge.
 */
export async function buildCertificate(request, parties, events, signedHash) {
  const { PDFDocument, StandardFonts, rgb } = await lib();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ink = rgb(0.07, 0.11, 0.15);
  const dim = rgb(0.45, 0.5, 0.55);
  const rule = rgb(0.83, 0.86, 0.88);

  let page = doc.addPage([612, 792]);      // US Letter, the North American default
  let y = 742;
  const M = 54;

  const line = (text, { size = 9.5, f = font, color = ink, gap = 14, indent = 0 } = {}) => {
    if (y < 60) { page = doc.addPage([612, 792]); y = 742; }
    page.drawText(String(text ?? ""), { x: M + indent, y, size, font: f, color });
    y -= gap;
  };
  const rule_ = (gap = 12) => {
    if (y < 60) { page = doc.addPage([612, 792]); y = 742; }
    page.drawLine({ start: { x: M, y }, end: { x: 612 - M, y }, thickness: 0.5, color: rule });
    y -= gap;
  };
  const heading = (t) => { y -= 6; line(t, { size: 11, f: bold, gap: 16 }); rule_(14); };

  line("CERTIFICATE OF COMPLETION", { size: 15, f: bold, gap: 20 });
  line("Baydo Pointe · 370 · 374 · 378 Clareview Station Drive NW, Edmonton, Alberta",
    { size: 9, color: dim, gap: 12 });
  line(`Reference ${request.reference}`, { size: 9, f: mono, color: dim, gap: 18 });

  heading("DOCUMENT");
  line(`Agreement:   ${request.agreement_name ?? ""}`);
  line(`Version:     ${request.version_label ?? ""}`);
  line(`File:        ${request.source_filename}`);
  if (request.unit_number) line(`Suite:       ${request.unit_number}`);
  y -= 4;
  line("Hash of the document as sent (SHA-256):", { size: 8.5, color: dim, gap: 11 });
  line(request.source_sha256, { size: 7.5, f: mono, gap: 13, indent: 8 });
  line("Hash of the signed document (SHA-256):", { size: 8.5, color: dim, gap: 11 });
  line(signedHash, { size: 7.5, f: mono, gap: 16, indent: 8 });

  heading("PARTIES");
  for (const p of parties) {
    line(`${p.full_name}   (${p.role})`, { size: 10, f: bold, gap: 13 });
    if (p.email) line(`Email:      ${p.email}`, { size: 8.5, color: dim, gap: 11, indent: 8 });
    line(`Consented:  ${p.consented_at ? String(p.consented_at).replace("T", " ").slice(0, 19) : "not recorded"}`,
      { size: 8.5, color: dim, gap: 11, indent: 8 });
    line(`Signed:     ${p.signed_at ? String(p.signed_at).replace("T", " ").slice(0, 19) : "not signed"}`,
      { size: 8.5, color: dim, gap: 11, indent: 8 });
    if (p.ip_address)
      line(`Address:    ${p.ip_address}`, { size: 8.5, color: dim, gap: 11, indent: 8 });
    if (p.signature_kind)
      line(`Mark:       ${p.signature_kind}`, { size: 8.5, color: dim, gap: 14, indent: 8 });
  }

  heading("HISTORY");
  for (const e of events) {
    const when = String(e.at).replace("T", " ").slice(0, 19);
    line(`${when}   ${e.event}${e.actor_name ? `  ·  ${e.actor_name}` : ""}`,
      { size: 8.5, gap: 11 });
    if (e.detail) line(e.detail, { size: 8, color: dim, gap: 11, indent: 12 });
  }

  y -= 8;
  heading("ABOUT THIS CERTIFICATE");
  const notes = [
    "This certificate records the electronic signing of the document named above.",
    "",
    "Each party confirmed, before signing, that they agreed to sign electronically.",
    "That consent is recorded above with its timestamp.",
    "",
    "The two hashes identify the document before and after signing. The document",
    "text was not altered: the signatures were drawn on top of the file as it was",
    "sent, and the version approved by counsel is retained unchanged and separately.",
    "",
    "A copy of the signed document that does not match the second hash above is not",
    "the document that was signed.",
  ];
  for (const n of notes) line(n, { size: 8.5, color: n ? ink : dim, gap: 11 });

  y -= 6;
  line(`Generated ${nowISO().replace("T", " ").slice(0, 19)}`,
    { size: 8, color: dim, gap: 11 });

  return Buffer.from(await doc.save());
}

/** Appends the certificate to the signed document, so the two cannot be
 *  separated by somebody forwarding only the pages they like. */
export async function attachCertificate(signedBuffer, certBuffer) {
  const { PDFDocument } = await lib();
  const out = await PDFDocument.load(signedBuffer, { ignoreEncryption: true });
  const cert = await PDFDocument.load(certBuffer);
  const pages = await out.copyPages(cert, cert.getPageIndices());
  for (const p of pages) out.addPage(p);
  return Buffer.from(await out.save());
}

/* ---------- Events ---------- */

export function recordEvent(requestId, event, { partyId, detail, ip, userAgent,
                                                sha256, actorName } = {}) {
  const id = "se_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`INSERT INTO signature_events (id, request_id, party_id, event, detail,
    ip_address, user_agent, sha256, actor_name) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, requestId, partyId ?? null, event, detail ?? null, ip ?? null,
         userAgent ? String(userAgent).slice(0, 300) : null, sha256 ?? null,
         actorName ?? null);
  return id;
}

/**
 * Everyone has signed. Builds the signed file, the certificate, stores both,
 * and returns the keys.
 *
 * Verifies the source hash first. If the stored file no longer matches what
 * was sent, something is wrong that a signature would only paper over.
 */
export async function finalise(request, parties, fields) {
  const source = await storage.get(request.source_key);
  if (!source) throw Object.assign(new Error("SOURCE_MISSING"), { status: 410 });

  const check = fileHash(source);
  if (check !== request.source_sha256)
    throw Object.assign(new Error("SOURCE_ALTERED"), { status: 409,
      expected: request.source_sha256, found: check });

  const signed = await applySignatures(source, fields, parties);
  const signedHash = fileHash(signed);

  const events = db.prepare(`SELECT * FROM signature_events WHERE request_id=?
    ORDER BY at`).all(request.id);
  const cert = await buildCertificate(request, parties, events, signedHash);
  const withCert = await attachCertificate(signed, cert);
  const finalHash = fileHash(withCert);

  const base = `signed/${request.reference}`;
  await storage.put(`${base}/agreement-signed.pdf`, withCert, "application/pdf");
  await storage.put(`${base}/certificate.pdf`, cert, "application/pdf");

  return {
    signed_key: `${base}/agreement-signed.pdf`,
    certificate_key: `${base}/certificate.pdf`,
    signed_sha256: finalHash,
    inner_sha256: signedHash,
  };
}
