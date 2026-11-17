// Password reset codes.
// The code is always printed in the server window. It is also emailed when SMTP_HOST is set
// (npm install nodemailer is already included), and texted when an SMS driver other than "log" is on.
import { SMS } from './config.js';
import { sendSms } from './sms.js';

export async function sendResetCode(user, code) {
  console.log(`[RESET CODE] ${user.email}: ${code} (valid for 60 minutes)`);

  if (SMS.driver !== 'log') {
    sendSms(user, `HelmLock password reset code: ${code}. It works for 60 minutes. Don't share it.`, 'reset');
  }

  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: 'HelmLock password reset code',
        text: `Your HelmLock reset code is ${code}. It works for 60 minutes.`,
      });
    } catch (e) {
      console.error('Could not send the reset email:', e.message);
    }
  }
}
