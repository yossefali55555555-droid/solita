import nodemailer from 'nodemailer';
import { getConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Outgoing email through Gmail SMTP with an app password of the owner's
 * Gmail account (decision in SPEC (ح): free, no card, ≤5 mails a day).
 * GMAIL_SMTP_USER / GMAIL_SMTP_APP_PASSWORD are set in Vercel by the owner.
 *
 * Email is best effort: a failure is logged and returned, it never fails
 * the action that triggered it (the in-app alert is the record).
 */

let transport = null;
let override = null;

/** Tests (and scripts) can capture mail instead of sending it. */
export function setMailTransport(t) {
  override = t;
  transport = null;
}

export function mailConfigured() {
  return Boolean(override) || getConfig().mail.configured;
}

function getTransport() {
  if (override) return override;
  if (!transport) {
    const { user, pass } = getConfig().mail;
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass },
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 10_000,
    });
  }
  return transport;
}

/** Returns { ok: true } or { ok: false, reason }. Never throws. */
export async function sendMail({ to, subject, text }) {
  if (!to) return { ok: false, reason: 'NO_RECIPIENT' };
  if (!mailConfigured()) return { ok: false, reason: 'MAIL_NOT_CONFIGURED' };
  try {
    const from = override ? 'test@solita.local' : getConfig().mail.user;
    await getTransport().sendMail({ from: `Solita <${from}>`, to, subject, text });
    return { ok: true };
  } catch (err) {
    logger.warn('Email sending failed', { error: err.message, code: err.code });
    return { ok: false, reason: 'SEND_FAILED' };
  }
}
