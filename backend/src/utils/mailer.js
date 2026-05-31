'use strict';

/**
 * mailer.js — reusable Nodemailer transporter (Gmail App Password / SMTP).
 * ─────────────────────────────────────────────────────────────────────────────
 * 100% free: uses a Gmail account + an App Password (no paid email service).
 *
 * Env vars (set in backend/.env — see README/.env.example):
 *   SMTP_USER  — the full Gmail address, e.g. yourbrand@gmail.com
 *   SMTP_PASS  — the 16-char Gmail App Password (NOT your normal password)
 *   SMTP_FROM  — (optional) display name/address for the From header
 *
 * The transporter is created lazily and cached, so we don't open a connection
 * (or crash) when email isn't configured — sends just no-op with a warning.
 */

const nodemailer = require('nodemailer');

let _transporter = null;
let _warnedMissing = false;

/** Build (once) and return the Gmail transporter, or null if not configured. */
function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    if (!_warnedMissing) {
      console.warn('⚠️  mailer: SMTP_USER / SMTP_PASS not set — emails will be skipped.');
      _warnedMissing = true;
    }
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',           // Gmail SMTP (smtp.gmail.com:465, secure)
    auth: { user, pass },
  });
  return _transporter;
}

/**
 * Low-level send helper. Never throws — logs and returns a result object so a
 * mail failure can't break the request that triggered it.
 * @returns {Promise<{sent: boolean, skipped?: boolean, error?: string}>}
 */
async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) return { sent: false, skipped: true };

  const from = process.env.SMTP_FROM || `"Scalyooo" <${process.env.SMTP_USER}>`;
  try {
    const info = await transporter.sendMail({ from, to, subject, text, html });
    console.log(`📧  mailer: sent "${subject}" → ${to} (id: ${info.messageId})`);
    return { sent: true };
  } catch (err) {
    console.error(`❌  mailer: failed to send to ${to}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Send the welcome / verification OTP to a newly created staff member.
 * @param {string} email - recipient email
 * @param {string} otp   - 6-digit code
 */
async function sendWelcomeOTP(email, otp) {
  const subject = 'رمز تفعيل حسابك — Scalyooo';
  const text =
    `مرحباً بك في Scalyooo!\n\n` +
    `رمز تفعيل حسابك هو: ${otp}\n\n` +
    `أدخل هذا الرمز لتأكيد بريدك الإلكتروني. الرمز صالح لاستخدام واحد.\n` +
    `إذا لم تطلب هذا الحساب، تجاهل هذه الرسالة.`;

  const html = `
  <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:auto;
    border:1px solid #e2e8f0;border-radius:16px;padding:32px;background:#ffffff;color:#0f172a">
    <h2 style="margin:0 0 8px;font-size:20px;">مرحباً بك في <span style="color:#4f46e5">Scalyooo</span> 👋</h2>
    <p style="color:#475569;font-size:14px;line-height:1.7;margin:0 0 20px">
      تم إنشاء حسابك بنجاح. استخدم رمز التفعيل التالي لتأكيد بريدك الإلكتروني:
    </p>
    <div style="text-align:center;margin:24px 0">
      <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:10px;
        color:#4f46e5;background:#eef2ff;border:1px solid #c7d2fe;border-radius:12px;
        padding:14px 24px;">${otp}</span>
    </div>
    <p style="color:#94a3b8;font-size:12px;line-height:1.7;margin:16px 0 0">
      هذا الرمز صالح لاستخدام واحد. إذا لم تطلب هذا الحساب، يمكنك تجاهل هذه الرسالة بأمان.
    </p>
  </div>`;

  return sendMail({ to: email, subject, html, text });
}

module.exports = { getTransporter, sendMail, sendWelcomeOTP };
