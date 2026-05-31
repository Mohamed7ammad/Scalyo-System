'use strict';

/**
 * alerts.js — automated operational alerts for staff.
 * ─────────────────────────────────────────────────────────────────────────────
 * Finds orders that are STAGNANT (still pending past a threshold) and emails the
 * assigned staff member a localized Arabic nudge to action them.
 *
 * "Pending" = 'جديد' (new, never actioned) or 'مؤجل' (postponed).
 * "Stagnant" = last activity (updatedAt, falling back to createdAt) older than
 *              STALE_HOURS. The updatedAt trigger bumps on every change, so this
 *              reflects genuine inactivity.
 *
 * Runs from the cron scheduler and from the admin manual-trigger endpoint — both
 * call the same function so behaviour is identical.
 */

const pool = require('../config/db');
const { sendMail } = require('../utils/mailer');

/* How old (hours) a pending order must be to count as "delayed". */
const STALE_HOURS = 24;

/* Statuses considered "pending / awaiting the agent". */
const PENDING_STATUSES = ['جديد', 'مؤجل'];

/** Build the Arabic alert email body for one staff member. */
function buildAlertEmail(name, count) {
  const greetingName = name && name.trim() ? name.trim() : 'عميلنا العزيز';
  const subject = 'تنبيه: طلبات متأخرة تحتاج لتأكيد';
  const text =
    `مرحباً ${greetingName}،\n\n` +
    `لديك ${count} طلب معلّق (جديد / مؤجل) منذ فترة طويلة دون متابعة.\n` +
    `يرجى مراجعتها وتأكيدها في أسرع وقت ممكن.\n\n` +
    `— فريق Scalyooo`;

  const html = `
  <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:auto;
    border:1px solid #e2e8f0;border-radius:16px;padding:32px;background:#ffffff;color:#0f172a">
    <h2 style="margin:0 0 12px;font-size:19px;">تنبيه: طلبات متأخرة ⏰</h2>
    <p style="color:#475569;font-size:14px;line-height:1.8;margin:0 0 16px">
      مرحباً <strong>${greetingName}</strong>،
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.8;margin:0 0 20px">
      لديك <strong style="color:#dc2626">${count}</strong> طلب معلّق
      <span style="color:#64748b">(جديد / مؤجل)</span> منذ فترة طويلة دون متابعة.
      يرجى مراجعتها وتأكيدها في أسرع وقت ممكن. 🙏
    </p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.7;margin:16px 0 0">
      هذه رسالة آلية من نظام Scalyooo.
    </p>
  </div>`;

  return { subject, html, text };
}

/**
 * Find delayed pending orders, group by assigned (active) staff member, and email
 * each one. Never throws — a failure is caught and reported so the cron tick and
 * the API request stay safe.
 *
 * @returns {Promise<{ alerted_staff_count: number, groups: number, error?: string }>}
 */
async function checkAndSendStaffAlerts() {
  try {
    /* One grouped query: delayed pending orders per active assigned staff member.
       Joining users on the AssignedTo email also yields the display name and
       filters out orders assigned to removed/inactive accounts. */
    const { rows } = await pool.query(
      `SELECT o."AssignedTo"        AS email,
              COALESCE(u.name, '')  AS name,
              COUNT(*)::int         AS delayed_count
         FROM orders o
         JOIN users  u ON u.email = o."AssignedTo"
                      AND COALESCE(u.is_active, true) = true
        WHERE o."AssignedTo" IS NOT NULL
          AND o."Status" = ANY($1::text[])
          AND COALESCE(o."updatedAt", o."createdAt") < NOW() - make_interval(hours => $2)
        GROUP BY o."AssignedTo", u.name`,
      [PENDING_STATUSES, STALE_HOURS]
    );

    if (rows.length === 0) {
      console.log('[alerts] No delayed pending orders — nothing to send.');
      return { alerted_staff_count: 0, groups: 0 };
    }

    let alerted = 0;
    for (const r of rows) {
      const { subject, html, text } = buildAlertEmail(r.name, r.delayed_count);
      const result = await sendMail({ to: r.email, subject, html, text });
      if (result.sent) {
        alerted += 1;
        console.log(`[alerts] ✅ ${r.email} → ${r.delayed_count} delayed order(s)`);
      } else if (result.skipped) {
        console.warn(`[alerts] ⏭️  ${r.email} skipped — mailer not configured`);
      } else {
        console.warn(`[alerts] ⚠️  ${r.email} send failed: ${result.error || 'unknown'}`);
      }
    }

    console.log(`[alerts] Done — ${alerted}/${rows.length} staff alerted.`);
    return { alerted_staff_count: alerted, groups: rows.length };
  } catch (err) {
    console.error('[alerts] checkAndSendStaffAlerts failed:', err.message);
    return { alerted_staff_count: 0, groups: 0, error: err.message };
  }
}

module.exports = { checkAndSendStaffAlerts, STALE_HOURS };
