# HelmLock server

One program, three jobs:

1. **The app's backend.** Everything in the app's `src/api/real.js` works (login, reserve, QR, admin screens, CSV export).
2. **The cabinet's scan route.** The ESP32 sends the scanned QR text and the coins inserted. The server decides whether the door may open.
3. **SMS notices.** Reserved, stored, retrieved, cancelled, no-show, "10 minutes left", "you are late".

QR codes are 64 random characters, work once, and a new OUT QR kills the old one. Passwords are hashed.

## How a scan works

| Cabinet sends | Server answers |
|---|---|
| `{token, coins: credit, dry: true}` | `action: "pay"` + `due` (not enough coins), or `store` / `retrieve` (OK to open), or `ok: false` (refused). Nothing is changed. |
| the door really opened, then `{token, coins: due, dry: false}` | the QR is marked used, the reservation moves to `stored` / `completed`, money is logged, SMS is sent |

So a stuck servo or a door nobody opens never burns a student's QR.

---

## A. Put it online (so it works without your laptop)

Free tiers change. Check each site's current limits before the demo.

1. **Neon** (database): create a project `helmlock`, press **Connect**, copy the `postgresql://...` string (show the password first).
2. **GitHub**: create a **private** repo `helmlock-server` and upload these files. Do NOT upload `.env`, `node_modules` or `data` (`.gitignore` already skips them).
3. **Render**: New > Web Service > pick the repo > Free instance.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment variables: `DATABASE_URL` (the Neon string), `LOCKER_KEY` (your own long secret), `NODE_VERSION` = `22`, `SMS_DRIVER` = `log` (change it later), `SEED_DEMO` = `true`
4. When it is live, open `https://YOUR-APP.onrender.com/up`. You should see `{"ok":true}`.
5. **UptimeRobot**: add an HTTP monitor for that `/up` address every 5 minutes. A free Render service sleeps after 15 minutes without traffic and takes about a minute to wake, so without this the first scan at the demo can time out.
6. Open `https://YOUR-APP.onrender.com/setup`, log in as `admin@helmlock.test` / `password`, and **change that password** (app: More > Profile).
   The page should say the data is saved in the online database.

## B. SMS (TextBee, recommended)

1. Install the TextBee app on a spare Android phone with a SIM that has load. Sign in, and keep it on, charged and online.
2. At textbee.dev, register that device and create an API key.
3. In Render, set `SMS_DRIVER` = `textbee` and `SMS_TEXTBEE_KEY` = your key (and `SMS_TEXTBEE_DEVICE_ID` if you have several phones). Redeploy.
4. On `/setup`, enter your number and press **Send test SMS**. If the text arrives, SMS works. A failure shows the error right there.

Other drivers: `semaphore` (needs an approved Sender Name, up to 5 business days, and paid credits), `android` (a phone on the same WiFi, so not for Render).
Texts use "P5" instead of the peso sign, so one text stays within the 160-character limit.

## C. The app

In `src/config.js`:

```js
export const USE_FAKE_API = false;
export const API_URL = 'https://YOUR-APP.onrender.com';
```

Make sure `RULES` there match the server (late grace 15 minutes, P5 fees, 7:00 to 21:00). Then rebuild the APK:

```powershell
git add .
git commit -m "Use the online server"
eas build -p android --profile preview
```

With an `https://` address you do not need the cleartext setting.

## D. The cabinet

1. Arduino IDE: open `esp32/helmlock_locker/helmlock_locker.ino`. Install the **ArduinoJson** library (version 7). The LCD and servo libraries are the ones you already use.
2. Set `WIFI_SSID`, `WIFI_PASS` (2.4 GHz only), `SERVER_URL` and `LOCKER_KEY` (exactly the same as Render).
3. Upload, open the Serial Monitor at 115200. You should see WiFi connect, and `/setup` should show "Cabinet last seen just now".
4. Power it from a USB adapter. Test with the servo only before the real door.

The firmware skips the HTTPS certificate check (`setInsecure()`), which is fine for a school demo but not for a public product.

## E. Test without the cabinet

On `/setup`, the **Cabinet simulator** does what the cabinet does. Copy the QR text from the app, enter coins, and press Scan (tick "dry run" to only check). This is also your backup if the hardware misbehaves at the demo.

## Run on your laptop instead

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm test        # should say pass 15
npm start
```

Use the address it prints as `API_URL` (`http://192.168.x.x:3000`). Installed APKs block plain `http://`, so that needs the `expo-build-properties` cleartext setting. Windows firewall: `netsh advfirewall firewall add rule name="HelmLock 3000" dir=in action=allow protocol=TCP localport=3000`

## Limits

- Everything is stored as one saved document: fine for a campus demo, not for thousands of users.
- Run only ONE copy of the server at a time.
- The ESP32 firmware and real SMS sending are not tested on your hardware or phone.
- `/api/locker/extend` from the old API is not included.
