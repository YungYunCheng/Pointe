import { Hono } from "hono";
import { hashPassword, randToken, sha256 } from "../lib/crypto.js";
import { require_, audit, uid } from "../lib/auth.js";

/* ============================================================
   Claiming an account, and email verification

   Two flows that look similar and are not.

   A tenant claims an account. They do not create one — they prove
   they are the person a lease already names, by receiving mail at
   the address on that lease. Anyone who could open an account by
   typing a suite number would be able to read somebody else's
   tenancy, which is worse than having no portal at all.

   A staff account is created by Admin and the person is invited.
   Nothing self-registers into a system that posts to the ledger.
   ============================================================ */

const r = new Hono();

const CLAIM_TTL_HOURS = 48;      // long enough to survive a weekend
const INVITE_TTL_HOURS = 72;
const RESEND_COOLDOWN_MINUTES = 2;
const MAX_SENDS = 5;

const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();

/** Gmail ignores dots and anything after a plus. Without normalising,
 *  a.b@gmail.com and ab@gmail.com look like two people to the database and
 *  like one person to the mail server. */
function normaliseEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  const [local, domain] = e.split("@");
  if (!domain) return e;
  if (["gmail.com", "googlemail.com"].includes(domain))
    return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return `${local.split("+")[0]}@${domain}`;
}

/* ============================================================
   Tenant: claim an account
   ============================================================ */

/**
 * Step one. Email and suite go in, an email may go out.
 *
 * The response is identical whether or not anything matched. It has to be:
 * a different answer for "no such suite" and "that is not the email on file"
 * turns this into a way to find out who lives where, one guess at a time.
 *
 * The attempt is logged either way, because a run of misses against different
 * suites from one address is somebody working through the building and the
 * log is the only place that difference exists.
 */
r.post("/public/tenant/claim", async (c) => {
  const sql = c.get("db");
  const { email, unit_number } = await c.req.json().catch(() => ({}));
  const ip = c.req.header("cf-connecting-ip") ?? null;

  const SAME_ANSWER = {
    ok: true,
    code: "CHECK_YOUR_EMAIL",
    detail: "If that suite and email match our records, a link is on its way. It is good for 48 hours.",
  };

  if (!email || !unit_number) return c.json({ code: "MISSING_FIELDS" }, 400);

  const norm = normaliseEmail(email);
  const unit = String(unit_number).trim();

  const logAttempt = async (matched, reason) =>
    sql`INSERT INTO claim_attempts (id, email, unit_number, matched, reason, ip, user_agent)
        VALUES (${uid("ca_")}, ${norm}, ${unit}, ${matched}, ${reason}, ${ip},
                ${(c.req.header("user-agent") ?? "").slice(0, 300)})`;

  // Somebody trying suites in sequence. Ten in an hour is not a person who
  // mistyped their own address.
  const [{ count: recent }] = await sql`
    SELECT COUNT(*)::int AS count FROM claim_attempts
    WHERE ip = ${ip} AND created_at > now() - INTERVAL '1 hour'`;
  if (recent >= 10) {
    await logAttempt(false, "rate_limited");
    return c.json(SAME_ANSWER);
  }

  /* The match. An active lease on that suite, whose contact holds that email.
     
     Both halves are required. The suite alone is public information — it is
     on the door. The email alone proves nothing about which suite. Together
     they are something only the tenant and the office know. */
  const [lease] = await sql`
    SELECT l.id, l.unit_number, l.contact_id, l.start_date, l.end_date,
           ct.full_name, ct.email, ct.locale
    FROM leases l
    JOIN contacts ct ON ct.id = l.contact_id
    WHERE l.unit_number = ${unit}
      AND l.status = 'active'
      AND ct.normalised_email = ${norm}
    LIMIT 1`;

  if (!lease) {
    await logAttempt(false, "no_match");
    return c.json(SAME_ANSWER);
  }

  const [existing] = await sql`
    SELECT id, email_verified_at FROM tenant_accounts
    WHERE unit_number = ${unit} AND is_active`;
  if (existing?.email_verified_at) {
    // Already claimed. Still the same answer outwardly, but a note goes to
    // the real address rather than a link — if somebody else is trying to
    // claim their suite, the tenant should hear about it.
    await logAttempt(false, "already_claimed");
    await sql`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
      subject, body, ref_type, ref_id)
      VALUES (${uid("ob_")}, 'email', ${lease.email}, ${lease.full_name},
              ${lease.locale ?? "en"}, 'security_notice',
              ${"Somebody tried to set up access for your suite"},
              ${[`Hello ${lease.full_name},`, "",
                 `Somebody asked to set up portal access for ${unit}. An account already exists, so no link was sent.`,
                 "",
                 "If that was you and you have forgotten your password, use the reset link on the sign-in page.",
                 "If it was not you, reply to this message and we will look into it.",
                ].join("\n")},
              'unit', ${unit})`;
    return c.json(SAME_ANSWER);
  }

  // Not too often. The cooldown is per address rather than per token, so
  // asking again does not restart the clock by creating a new row.
  const [last] = await sql`
    SELECT * FROM email_verifications
    WHERE email = ${norm} AND purpose = 'tenant_claim' AND used_at IS NULL
    ORDER BY last_sent_at DESC LIMIT 1`;

  if (last) {
    const since = (Date.now() - new Date(last.last_sent_at).getTime()) / 60000;
    if (since < RESEND_COOLDOWN_MINUTES) {
      await logAttempt(true, "cooldown");
      return c.json(SAME_ANSWER);
    }
    if (last.sent_count >= MAX_SENDS) {
      await logAttempt(true, "max_sends");
      return c.json(SAME_ANSWER);
    }
  }

  const raw = randToken();
  const link = `${c.env.PUBLIC_TENANT_URL}/claim?token=${raw}`;
  const zh = lease.locale === "zh";

  await sql.begin(async (tx) => {
    if (last) {
      // Reuse the row so the send count and the cooldown mean something.
      // A new row per request would let somebody mail-bomb the tenant by
      // asking repeatedly.
      await tx`UPDATE email_verifications
        SET token_hash = ${await sha256(raw)}, expires_at = ${hoursFromNow(CLAIM_TTL_HOURS)},
            sent_count = sent_count + 1, last_sent_at = now(), requested_ip = ${ip}
        WHERE id = ${last.id}`;
    } else {
      await tx`INSERT INTO email_verifications (id, purpose, email, unit_number,
        lease_id, contact_id, full_name, locale, token_hash, expires_at, requested_ip)
        VALUES (${uid("ev_")}, 'tenant_claim', ${norm}, ${unit}, ${lease.id},
                ${lease.contact_id}, ${lease.full_name}, ${lease.locale ?? "en"},
                ${await sha256(raw)}, ${hoursFromNow(CLAIM_TTL_HOURS)}, ${ip})`;
    }

    // Sent to the address on the lease, not to the address that was typed.
    // Those are the same when the match succeeded, and saying so here is what
    // stops a later change to this code sending it somewhere else.
    await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
      subject, body, ref_type, ref_id, required_by)
      VALUES (${uid("ob_")}, 'email', ${lease.email}, ${lease.full_name},
              ${lease.locale ?? "en"}, 'tenant_claim',
              ${zh ? `設定 ${unit} 的住戶專區` : `Set up your Baydo Pointe account · ${unit}`},
              ${(zh ? [
                `${lease.full_name} 你好，`, "",
                `請用以下連結設定 ${unit} 的住戶專區密碼：`, "",
                link, "",
                "連結 48 小時內有效，只能使用一次。",
                "",
                "如果不是你要求的，可以忽略這封信，不會有任何變動。",
              ] : [
                `Hello ${lease.full_name},`, "",
                `Use this link to set a password for your Baydo Pointe account for ${unit}:`,
                "", link, "",
                "It works once and expires in 48 hours.",
                "",
                "If you did not ask for this, ignore it — nothing has changed.",
              ]).join("\n")},
              'unit', ${unit}, ${hoursFromNow(1)})`;
  });

  await logAttempt(true, "sent");
  return c.json(SAME_ANSWER);
});

/** What the link is for, before anybody types a password. Shows the suite so
 *  the person can tell they have the right one, and nothing else. */
r.get("/public/verify/:token", async (c) => {
  const sql = c.get("db");
  const [v] = await sql`
    SELECT purpose, email, unit_number, full_name, locale, expires_at, used_at
    FROM email_verifications WHERE token_hash = ${await sha256(c.req.param("token"))}`;

  if (!v) return c.json({ code: "INVALID_TOKEN" }, 404);
  if (v.used_at) return c.json({ code: "ALREADY_USED" }, 410);
  if (new Date(v.expires_at) < new Date())
    return c.json({ code: "EXPIRED", expired_at: v.expires_at }, 410);

  return c.json({
    purpose: v.purpose,
    // The email is masked. The link may have been forwarded, and the address
    // is not the recipient's to give away.
    email: maskEmail(v.email),
    unit_number: v.unit_number,
    full_name: v.full_name,
    locale: v.locale,
    expires_at: v.expires_at,
  });
});

/**
 * Step two. The link is opened and a password is set.
 *
 * This is where the account comes into existence. Everything before it was a
 * claim; opening mail at the address on the lease is what makes it true.
 */
r.post("/public/verify/:token", async (c) => {
  const sql = c.get("db");
  const { password } = await c.req.json().catch(() => ({}));
  const ip = c.req.header("cf-connecting-ip") ?? null;

  const issues = passwordIssues(password);
  if (issues.length) return c.json({ code: "PASSWORD_TOO_WEAK", issues }, 400);

  const hash = await sha256(c.req.param("token"));

  try {
    const out = await sql.begin(async (tx) => {
      // Locked, so two clicks on the same link cannot both create an account.
      // People do double-click links in email, and without this the second
      // one either errors confusingly or makes a duplicate.
      const [v] = await tx`
        SELECT * FROM email_verifications WHERE token_hash = ${hash} FOR UPDATE`;

      if (!v) throw Object.assign(new Error("INVALID_TOKEN"), { status: 404 });
      if (v.used_at) throw Object.assign(new Error("ALREADY_USED"), { status: 410 });
      if (new Date(v.expires_at) < new Date())
        throw Object.assign(new Error("EXPIRED"), { status: 410 });

      const h = await hashPassword(password, tx);

      if (v.purpose === "tenant_claim") {
        // The lease is re-checked here, not trusted from when the email went
        // out. A tenancy that ended in the two days since should not open an
        // account.
        const [lease] = await tx`
          SELECT id, unit_number, contact_id FROM leases
          WHERE id = ${v.lease_id} AND status = 'active'`;
        if (!lease)
          throw Object.assign(new Error("LEASE_NO_LONGER_ACTIVE"), { status: 409,
            detail: "That tenancy is no longer active. Contact the office." });

        const [account] = await tx`
          INSERT INTO tenant_accounts (id, contact_id, email, full_name, unit_number,
            lease_id, locale, password_algo, password_salt, password_hash,
            password_params, password_changed_at, email_verified_at, claimed_at,
            is_active)
          VALUES (${uid("ta_")}, ${v.contact_id}, ${v.email}, ${v.full_name},
                  ${v.unit_number}, ${v.lease_id}, ${v.locale},
                  ${h.algo}, ${h.salt}, ${h.hash}, ${h.params},
                  now(), now(), now(), TRUE)
          ON CONFLICT (unit_number) WHERE is_active DO NOTHING
          RETURNING id, email, full_name, unit_number, locale`;

        if (!account)
          throw Object.assign(new Error("ALREADY_CLAIMED"), { status: 409 });

        await tx`UPDATE email_verifications SET used_at = now(), claimed_ip = ${ip}
          WHERE id = ${v.id}`;
        return { kind: "tenant", account };
      }

      if (v.purpose === "staff_invite") {
        const [user] = await tx`
          UPDATE users SET password_algo = ${h.algo}, password_salt = ${h.salt},
            password_hash = ${h.hash}, password_params = ${h.params},
            password_changed_at = now(),
            password_expires_at = ${hoursFromNow(182 * 24)},
            email_verified_at = now(), must_change_password = FALSE,
            is_active = TRUE
          WHERE id = ${v.user_id}
          RETURNING id, email, full_name, role_code`;
        if (!user) throw Object.assign(new Error("USER_NOT_FOUND"), { status: 404 });

        await tx`UPDATE email_verifications SET used_at = now(), claimed_ip = ${ip}
          WHERE id = ${v.id}`;
        return { kind: "staff", user };
      }

      throw Object.assign(new Error("UNSUPPORTED_PURPOSE"), { status: 400 });
    });

    return c.json({ ok: true, ...out,
      note: "Your account is set up. Sign in with the password you just chose." }, 201);
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

/* ============================================================
   Staff: invited, never self-registered
   ============================================================ */

/**
 * Admin creates the account and the person sets their own password.
 *
 * Nobody is sent a password. A password in an email is a password sitting in
 * two mailboxes forever, and it is the one credential the sender can also
 * read.
 */
r.post("/admin/users/invite", require_("users.manage"), async (c) => {
  const sql = c.get("db");
  const { email, full_name, phone, role_code, locale } = await c.req.json();

  if (!email || !full_name || !role_code)
    return c.json({ code: "MISSING_FIELDS" }, 400);
  // A phone is required, not optional. An account reachable on one channel is
  // an account locked out the day that channel fails.
  if (!phone) return c.json({ code: "PHONE_REQUIRED",
    detail: "A second channel is needed. One address is a lockout waiting to happen." }, 400);

  const [role] = await sql`SELECT code FROM roles WHERE code = ${role_code}`;
  if (!role) return c.json({ code: "UNKNOWN_ROLE" }, 400);

  const raw = randToken();
  const norm = normaliseEmail(email);

  try {
    const out = await sql.begin(async (tx) => {
      const [user] = await tx`
        INSERT INTO users (id, email, full_name, phone, role_code, locale,
          is_active, must_change_password, invited_at, invited_by)
        VALUES (${uid("usr_")}, ${String(email).trim()}, ${full_name}, ${phone},
                ${role_code}, ${locale ?? "en"}, FALSE, TRUE, now(),
                ${c.get("user").id})
        RETURNING id, email, full_name, role_code`;

      await tx`INSERT INTO email_verifications (id, purpose, email, user_id,
        role_code, full_name, locale, token_hash, expires_at, created_by)
        VALUES (${uid("ev_")}, 'staff_invite', ${norm}, ${user.id}, ${role_code},
                ${full_name}, ${locale ?? "en"}, ${await sha256(raw)},
                ${hoursFromNow(INVITE_TTL_HOURS)}, ${c.get("user").id})`;

      const link = `${c.env.PUBLIC_URL}/claim?token=${raw}`;
      await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
        subject, body, ref_type, ref_id)
        VALUES (${uid("ob_")}, 'email', ${user.email}, ${full_name},
                ${locale ?? "en"}, 'staff_invite',
                'Set up your Baydo Pointe account',
                ${[`Hello ${full_name},`, "",
                   `${c.get("user").name} has set up an account for you at Baydo Pointe.`,
                   "", "Choose your password here:", "", link, "",
                   `The link works once and expires in ${INVITE_TTL_HOURS} hours.`,
                   "", "Nobody sends a password by email, including us. If you ever get one, it did not come from here.",
                  ].join("\n")},
                'user', ${user.id})`;

      return user;
    });

    // The account exists but cannot be signed into until the link is used —
    // is_active is false and there is no hash. That is the right state for an
    // account nobody has claimed.
    await audit(c, { action: "user.invite", entityType: "user", entityId: out.id,
      after: { email: out.email, role: role_code, invited_by: c.get("user").name } });

    return c.json({ user: out, invited: true,
      note: "They set their own password from the link. The account cannot be signed into until they do." }, 201);
  } catch (e) {
    if (String(e.message).includes("unique") || e.code === "23505")
      return c.json({ code: "EMAIL_IN_USE" }, 409);
    throw e;
  }
});

r.post("/admin/users/:id/reinvite", require_("users.manage"), async (c) => {
  const sql = c.get("db");
  const [u] = await sql`SELECT * FROM users WHERE id = ${c.req.param("id")}`;
  if (!u) return c.json({ code: "USER_NOT_FOUND" }, 404);
  if (u.password_hash) return c.json({ code: "ALREADY_SET_UP" }, 409);

  const raw = randToken();
  await sql.begin(async (tx) => {
    await tx`UPDATE email_verifications SET used_at = now()
      WHERE user_id = ${u.id} AND purpose = 'staff_invite' AND used_at IS NULL`;
    await tx`INSERT INTO email_verifications (id, purpose, email, user_id, role_code,
      full_name, locale, token_hash, expires_at, created_by)
      VALUES (${uid("ev_")}, 'staff_invite', ${normaliseEmail(u.email)}, ${u.id},
              ${u.role_code}, ${u.full_name}, ${u.locale ?? "en"},
              ${await sha256(raw)}, ${hoursFromNow(INVITE_TTL_HOURS)},
              ${c.get("user").id})`;
    await tx`INSERT INTO outbox (id, channel, to_email, to_name, kind, subject, body,
      ref_type, ref_id)
      VALUES (${uid("ob_")}, 'email', ${u.email}, ${u.full_name}, 'staff_invite',
              'Set up your Baydo Pointe account',
              ${[`Hello ${u.full_name},`, "",
                 "Here is a fresh link to choose your password:", "",
                 `${c.env.PUBLIC_URL}/claim?token=${raw}`, "",
                 `It works once and expires in ${INVITE_TTL_HOURS} hours.`,
                ].join("\n")},
              'user', ${u.id})`;
  });

  // The old link stops working. A reinvite that leaves the previous one live
  // means two ways into the same account, and only one of them was asked for.
  await audit(c, { action: "user.reinvite", entityType: "user", entityId: u.id });
  return c.json({ ok: true, note: "Any earlier link has stopped working." });
});


/* ============================================================
   Prospects: signing up before there is a suite
   ============================================================ */

/**
 * Anybody can sign up. What they get is an account and nothing else — no
 * suite, no lease, no access to anything about a tenancy.
 *
 * That is what makes self-service safe here. The account is a place to keep
 * their own viewings and applications, and the only thing it can show them is
 * what they themselves submitted. Being linked to a suite is a separate act,
 * done by staff when a lease is signed, because staff are the ones who know
 * it was.
 */
r.post("/public/signup", async (c) => {
  const sql = c.get("db");
  const { email, full_name, phone, locale, password } = await c.req.json().catch(() => ({}));
  const ip = c.req.header("cf-connecting-ip") ?? null;

  if (!email || !full_name?.trim())
    return c.json({ code: "MISSING_FIELDS" }, 400);

  const issues = passwordIssues(password);
  if (issues.length) return c.json({ code: "PASSWORD_TOO_WEAK", issues }, 400);

  const norm = normaliseEmail(email);

  const log = (outcome) =>
    sql`INSERT INTO signup_attempts (id, email, outcome, ip, user_agent)
        VALUES (${uid("sa_")}, ${norm}, ${outcome}, ${ip},
                ${(c.req.header("user-agent") ?? "").slice(0, 300)})`;

  // Five in an hour from one address is not five people looking for a flat.
  const [{ count: recent }] = await sql`
    SELECT COUNT(*)::int AS count FROM signup_attempts
    WHERE ip = ${ip} AND created_at > now() - INTERVAL '1 hour'`;
  if (recent >= 5) {
    await log("rate_limited");
    return c.json({ code: "TOO_MANY", detail: "Too many sign-ups from here. Try again later." }, 429);
  }

  const SAME_ANSWER = {
    ok: true, code: "CHECK_YOUR_EMAIL",
    detail: "Check your email for a link to confirm the address. It is good for 48 hours.",
  };

  const [existing] = await sql`
    SELECT id, email_verified_at FROM tenant_accounts
    WHERE lower(email) = ${norm} AND is_active`;

  if (existing) {
    // The same answer as a new sign-up. Saying "that email is taken" tells
    // anybody who asks which addresses have accounts here, and the person who
    // genuinely forgot gets the note below instead.
    await log("already_exists");
    await sql`INSERT INTO outbox (id, channel, to_email, kind, subject, body,
      ref_type, ref_id)
      VALUES (${uid("ob_")}, 'email', ${email}, 'signup_exists',
              'You already have a Baydo Pointe account',
              ${["Hello,", "",
                 "Somebody tried to sign up with this address, and it already has an account.",
                 "",
                 "If that was you, sign in as usual — or use the reset link if the password has slipped your mind.",
                 "If it was not you, nothing has changed and you can ignore this.",
                ].join("\n")},
              'account', ${existing.id})`;
    return c.json(SAME_ANSWER);
  }

  const raw = randToken();
  const h = await hashPassword(password, sql);

  await sql.begin(async (tx) => {
    // Created straight away, unverified. Keeping the password in a token row
    // until the link is opened would mean holding a plaintext-derived secret
    // outside the accounts table for two days.
    const [account] = await tx`
      INSERT INTO tenant_accounts (id, email, full_name, phone, locale,
        account_state, password_algo, password_salt, password_hash,
        password_params, password_changed_at, signup_ip, is_active)
      VALUES (${uid("ta_")}, ${String(email).trim()}, ${full_name.trim()},
              ${phone ?? null}, ${locale ?? "en"}, 'prospect',
              ${h.algo}, ${h.salt}, ${h.hash}, ${h.params}, now(), ${ip}, TRUE)
      RETURNING id`;

    await tx`INSERT INTO email_verifications (id, purpose, email, full_name,
      locale, token_hash, expires_at, requested_ip)
      VALUES (${uid("ev_")}, 'signup', ${norm}, ${full_name.trim()},
              ${locale ?? "en"}, ${await sha256(raw)},
              ${hoursFromNow(CLAIM_TTL_HOURS)}, ${ip})`;

    const zh = locale === "zh";
    await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
      subject, body, ref_type, ref_id, required_by)
      VALUES (${uid("ob_")}, 'email', ${String(email).trim()}, ${full_name.trim()},
              ${locale ?? "en"}, 'signup_verify',
              ${zh ? "確認你的 Email" : "Confirm your email · Baydo Pointe"},
              ${(zh ? [
                `${full_name.trim()} 你好，`, "",
                "請點以下連結確認這個 Email，之後就可以預約看房和送出申請：",
                "", `${c.env.PUBLIC_TENANT_URL}/verify?token=${raw}`, "",
                "連結 48 小時內有效。",
                "", "如果不是你註冊的，忽略這封信即可。",
              ] : [
                `Hello ${full_name.trim()},`, "",
                "Confirm this address and you can book viewings and apply:",
                "", `${c.env.PUBLIC_TENANT_URL}/verify?token=${raw}`, "",
                "The link is good for 48 hours.",
                "", "If you did not sign up, ignore this — nothing else happens.",
              ]).join("\n")},
              'account', ${account.id}, ${hoursFromNow(1)})`;
  });

  await log("created");
  return c.json(SAME_ANSWER, 201);
});

/** Confirming the address. Nothing before this point lets them book anything —
 *  an unconfirmed address is one nobody can be reached at, and a viewing
 *  booked against it is a slot held for somebody who will not hear about it. */
r.post("/public/verify-signup/:token", async (c) => {
  const sql = c.get("db");
  const hash = await sha256(c.req.param("token"));

  try {
    const out = await sql.begin(async (tx) => {
      const [v] = await tx`SELECT * FROM email_verifications
        WHERE token_hash = ${hash} AND purpose = 'signup' FOR UPDATE`;
      if (!v) throw Object.assign(new Error("INVALID_TOKEN"), { status: 404 });
      if (v.used_at) throw Object.assign(new Error("ALREADY_USED"), { status: 410 });
      if (new Date(v.expires_at) < new Date())
        throw Object.assign(new Error("EXPIRED"), { status: 410 });

      const [account] = await tx`
        UPDATE tenant_accounts SET email_verified_at = now()
        WHERE lower(email) = ${v.email} AND is_active
        RETURNING id, email, full_name, locale, account_state`;
      if (!account) throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), { status: 404 });

      await tx`UPDATE email_verifications SET used_at = now() WHERE id = ${v.id}`;
      return account;
    });

    return c.json({ ok: true, account: out,
      note: "Address confirmed. You can sign in and book a viewing." });
  } catch (e) {
    return c.json({ code: e.message }, e.status ?? 500);
  }
});

/* ============================================================
   Linking an account to a lease — staff only
   ============================================================ */

/**
 * Turning a prospect into a tenant.
 *
 * This is the one thing that must never be self-service. An account that
 * could attach itself to a suite would be able to read whoever lives there,
 * and the sign-up form would be the way in.
 *
 * Done when the lease is signed, by whoever signed it.
 */
r.post("/accounts/:id/link", require_("lease.sign"), async (c) => {
  const sql = c.get("db");
  const { lease_id } = await c.req.json();
  if (!lease_id) return c.json({ code: "LEASE_REQUIRED" }, 400);

  try {
    const out = await sql.begin(async (tx) => {
      const [account] = await tx`
        SELECT * FROM tenant_accounts WHERE id = ${c.req.param("id")} FOR UPDATE`;
      if (!account) throw Object.assign(new Error("ACCOUNT_NOT_FOUND"), { status: 404 });
      if (account.account_state === "tenant")
        throw Object.assign(new Error("ALREADY_LINKED"), { status: 409,
          detail: `Already linked to ${account.unit_number}.` });

      const [lease] = await tx`
        SELECT * FROM leases WHERE id = ${lease_id} AND status = 'active'`;
      if (!lease) throw Object.assign(new Error("LEASE_NOT_ACTIVE"), { status: 404 });

      // One account per suite. Two would mean two people seeing the same
      // tenancy with nothing to say which of them the lease names.
      const [taken] = await tx`
        SELECT id, email FROM tenant_accounts
        WHERE unit_number = ${lease.unit_number} AND account_state = 'tenant'
          AND is_active`;
      if (taken)
        throw Object.assign(new Error("UNIT_ALREADY_LINKED"), { status: 409,
          detail: `${lease.unit_number} is already linked to ${taken.email}.` });

      // The address has to be confirmed first. Linking an unverified account
      // gives tenancy access to an address nobody has proved they can read.
      if (!account.email_verified_at)
        throw Object.assign(new Error("EMAIL_NOT_VERIFIED"), { status: 409,
          detail: "They have not confirmed their email address yet." });

      const [updated] = await tx`
        UPDATE tenant_accounts
        SET account_state = 'tenant', unit_number = ${lease.unit_number},
            lease_id = ${lease.id}, contact_id = ${lease.contact_id},
            linked_by = ${c.get("user").id}, linked_at = now()
        WHERE id = ${account.id}
        RETURNING id, email, full_name, unit_number, account_state`;

      await tx`INSERT INTO outbox (id, channel, to_email, to_name, locale, kind,
        subject, body, ref_type, ref_id)
        VALUES (${uid("ob_")}, 'email', ${account.email}, ${account.full_name},
                ${account.locale ?? "en"}, 'portal_access',
                ${`Your Baydo Pointe portal is open · ${lease.unit_number}`},
                ${[`Hello ${account.full_name},`, "",
                   `Your account now covers ${lease.unit_number}. Sign in with the same password to see your lease, report repairs, and check your balance.`,
                   "", `${c.env.PUBLIC_TENANT_URL}/portal`, "",
                   "Welcome.",
                  ].join("\n")},
                'unit', ${lease.unit_number})`;

      return updated;
    });

    await audit(c, { action: "account.link", entityType: "tenant_account",
      entityId: out.id, after: { unit: out.unit_number, by: c.get("user").name } });

    return c.json({ ok: true, account: out });
  } catch (e) {
    return c.json({ code: e.message, detail: e.detail }, e.status ?? 500);
  }
});

/** Unlinking, at move-out. The account survives — somebody who leaves and
 *  comes back should not have to start again, and the applications they made
 *  are still theirs. */
r.post("/accounts/:id/unlink", require_("moveout.process"), async (c) => {
  const sql = c.get("db");
  const [account] = await sql`
    UPDATE tenant_accounts
    SET account_state = 'former', unit_number = NULL, lease_id = NULL,
        moved_out_at = now()
    WHERE id = ${c.req.param("id")} AND account_state = 'tenant'
    RETURNING id, email, full_name`;
  if (!account) return c.json({ code: "NOT_LINKED" }, 404);

  await audit(c, { action: "account.unlink", entityType: "tenant_account",
    entityId: account.id, after: { by: c.get("user").name } });
  return c.json({ ok: true, account });
});

/** Prospects with no suite, so staff can find the account to link when a
 *  lease is signed. */
r.get("/accounts", require_("leads.view"), async (c) => {
  const sql = c.get("db");
  const state = c.req.query("state") ?? "prospect";
  return c.json({ accounts: await sql`
    SELECT id, email, full_name, phone, locale, account_state, unit_number,
           email_verified_at, created_at
    FROM tenant_accounts
    WHERE is_active AND account_state = ${state}
    ORDER BY created_at DESC LIMIT 200` });
});

/* ---------- Password rules ----------
   Length carries more than composition. Twelve characters of anything beats
   eight with a symbol somebody wrote on a note, which is what composition
   rules actually produce. */
function passwordIssues(pw) {
  const issues = [];
  if (!pw || pw.length < 12) issues.push("At least 12 characters.");
  if (/^\d+$/.test(pw ?? "")) issues.push("Not only numbers.");
  if (/^(.)\1+$/.test(pw ?? "")) issues.push("Not the same character repeated.");
  if (["password", "baydo", "pointe", "mizar", "clareview", "edmonton"]
      .some((w) => (pw ?? "").toLowerCase().includes(w)))
    issues.push("Nothing to do with the property, or the word password.");
  return issues;
}

const maskEmail = (e) => {
  const [l, d] = String(e).split("@");
  if (!d) return "•••";
  return `${l.slice(0, 2)}${"•".repeat(Math.max(2, l.length - 2))}@${d}`;
};

export default r;
