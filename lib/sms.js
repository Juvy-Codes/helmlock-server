// Sends SMS notices to students. It never throws: if sending fails, the app keeps working
// and the failure is written to the SMS log (admins see it on the /setup page).
//
// SMS_DRIVER in .env:
//   log       = only print the message in the server log (default, free, for testing)
//   textbee   = textbee.dev. Your own Android phone + SIM sends the texts. Works from an online server.
//   semaphore = Semaphore.co (Philippine SMS service, needs an approved Sender Name and credits)
//   android   = a phone on the SAME WiFi as the server (only for a server on your own network)
import { SMS } from './config.js';
import { db, newId, scheduleSave } from './store.js';

// 09171234567 -> +639171234567
export function toInternational(mobile) {
  const m = String(mobile || '').replace(/[\s-]/g, '');
  if (/^09\d{9}$/.test(m)) return '+63' + m.slice(1);
  if (/^639\d{9}$/.test(m)) return '+' + m;
  return m;
}

// SMS only fits 160 plain characters per text. The peso sign is not plain, so write "P5" instead.
const plain = (text) => text.replace(/₱/g, 'P');

async function deliver(user, text) {
  switch (SMS.driver) {
    case 'log':
      console.log(`[SMS to ${user.mobile}] ${text}`);
      return;

    case 'textbee': {
      if (!SMS.textbeeKey) throw new Error('SMS_TEXTBEE_KEY is empty');
      const res = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': SMS.textbeeKey },
        body: JSON.stringify({
          recipients: [toInternational(user.mobile)],
          message: text,
          ...(SMS.textbeeDevice ? { deviceId: SMS.textbeeDevice } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('TextBee answered HTTP ' + res.status);
      return;
    }

    case 'semaphore': {
      if (!SMS.semaphoreKey) throw new Error('SMS_SEMAPHORE_KEY is empty');
      const body = new URLSearchParams({ apikey: SMS.semaphoreKey, number: user.mobile, message: text });
      if (SMS.sender) body.set('sendername', SMS.sender);
      const res = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', body, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('Semaphore answered HTTP ' + res.status);
      return;
    }

    case 'android': {
      if (!SMS.androidUrl) throw new Error('SMS_ANDROID_URL is empty');
      const auth = Buffer.from(`${SMS.androidUser}:${SMS.androidPass}`).toString('base64');
      const res = await fetch(SMS.androidUrl.replace(/\/$/, '') + SMS.androidPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
        body: JSON.stringify({ message: text, phoneNumbers: [toInternational(user.mobile)] }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error('SMS phone answered HTTP ' + res.status);
      return;
    }

    default:
      throw new Error('Unknown SMS_DRIVER: ' + SMS.driver);
  }
}

// Returns the log entry, so a caller (the /setup test button) can show the result
export async function sendSms(user, text, kind = 'notice') {
  if (!user || !user.mobile) return null;
  const entry = {
    id: newId(),
    user_id: user.id,
    to: user.mobile,
    kind,
    text: plain(text),
    driver: SMS.driver,
    status: 'queued',
    created_at: new Date().toISOString(),
  };
  db.smsLog.unshift(entry);
  if (db.smsLog.length > 300) db.smsLog.length = 300;
  try {
    await deliver(user, entry.text);
    entry.status = 'sent';
  } catch (e) {
    entry.status = 'failed';
    entry.error = String(e.message || e).slice(0, 200);
    console.error('SMS failed:', entry.error);
  }
  scheduleSave();
  return entry;
}
