// Start the server:  npm start
import './lib/tz.js';
import os from 'node:os';
import { createApp } from './app.js';
import { init, saveNow, scheduleSave, closeStore, DB_FILE, STORAGE } from './lib/store.js';
import { seed, tick } from './lib/service.js';
import { LOCKER_KEY, SMS } from './lib/config.js';

const found = await init();
if (found) {
  console.log('Loaded the saved data from', STORAGE === 'postgres' ? 'the online database' : DB_FILE);
} else {
  seed(process.env.SEED_DEMO !== 'false');
  await saveNow();
  console.log('First start: created the starting data in', STORAGE === 'postgres' ? 'the online database' : DB_FILE);
}

const port = Number(process.env.PORT || 3000);
createApp().listen(port, '0.0.0.0', () => {
  console.log(`\nHelmLock server is running on port ${port}`);
  console.log(`Storage: ${STORAGE}   SMS driver: ${SMS.driver}\n`);
  if (!process.env.RENDER && !process.env.PORT_IS_HOSTED) {
    console.log('On your own network, put ONE of these in the app (src/config.js -> API_URL):');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${port}`);
    }
  }
  if (LOCKER_KEY === 'change-me-locker-key') console.log('WARNING: LOCKER_KEY is still the default. Set your own in .env / your host settings and in the ESP32 code.');
  if (STORAGE === 'file' && process.env.RENDER) console.log('WARNING: no DATABASE_URL set. Render wipes files on restart, so your data would be lost.');
});

// Every minute: no-show expiry, "time almost up" and "you are late" texts
setInterval(() => {
  try {
    tick();
    scheduleSave();
  } catch (e) {
    console.error('Background check failed:', e);
  }
}, 60 * 1000);

// Save before closing
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await closeStore();
    } finally {
      process.exit(0);
    }
  });
}
