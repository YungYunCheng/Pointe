/* ============================================================
   Legal figures

   One file, because these decide whether a notice is valid and a
   copy of 365 typed into a query is a copy nobody finds the day
   the number changes.

   Every one of them is the law rather than a preference. Confirm
   each with your lawyer before the first notice goes out — they
   are written here as constants precisely so that confirming them
   is a single afternoon rather than a search.
   ============================================================ */

/** Between one rent increase and the next. Runs from the date on the
 *  agreement — the commencement date, or the effective date of the last
 *  increase — never from a signing date or a row's created_at. */
export const INCREASE_INTERVAL_DAYS = 365;

/** Database backstop only. Alberta requires three full tenancy months for a
 *  month-to-month periodic tenancy; route code uses
 *  MONTHLY_INCREASE_NOTICE_MONTHS because 90 calendar days is not equivalent. */
export const INCREASE_NOTICE_DAYS = 90;
export const MONTHLY_INCREASE_NOTICE_MONTHS = 3;

/** Notice to end a tenancy. Different by term type. */
export const END_NOTICE_DAYS = { fixed: 0, periodic: 90 };

/** How long before a lease ends that renewals are worth raising. Not a legal
 *  figure — a practical one. Earlier than the notice period, so there is room
 *  for a conversation before there is a deadline. */
export const RENEWAL_LEAD_DAYS = 90;

/** When something counts as received. The notice period runs from this date,
 *  not from the day it was sent, and ordinary mail is the one that catches
 *  people out. */
export const DEEMED_SERVICE_DAYS = {
  personal: 0,
  posted_on_door: 0,
  email: 0,
  sms: 0,
  courier: 1,
  post: 5,
};

/** Methods that leave no delivery report, so proof has to be made by hand.
 *  An application turns on service far more often than on the amount. */
export const NEEDS_PROOF_OF_SERVICE = ["personal", "posted_on_door", "post"];

/** Entry to an occupied suite. */
export const ENTRY_NOTICE_HOURS = 24;

/** Returning a deposit after a tenancy ends. */
export const DEPOSIT_REFUND_DAYS = 10;

/** A charge day above this skips February silently, and a month with no rent
 *  raised looks exactly like a month with no arrears. */
export const MAX_CHARGE_DAY = 28;

export const RULES_NOTE =
  "These are legal figures for Alberta, written as constants so they can be confirmed in one place. Confirm each before relying on it.";
