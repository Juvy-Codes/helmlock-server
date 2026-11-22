// All settings in one place. Change them in the .env file (see .env.example)
// or in your host's "Environment variables" page.
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// Locker rules. These must match RULES in the app's src/config.js.
export const RULES = {
  openHour: num(process.env.OPEN_HOUR, 7), // lockers open at 7:00 AM
  closeHour: num(process.env.CLOSE_HOUR, 21), // lockers close at 9:00 PM
  dropOffFee: num(process.env.DROP_OFF_FEE, 5), // pesos to store the helmet (IN)
  hourlyFee: num(process.env.HOURLY_FEE, 5), // pesos per reserved hour, paid at retrieval (OUT)
  lateFeePerHour: num(process.env.LATE_FEE_PER_HOUR, 5), // extra pesos per late hour
  maxLateFee: num(process.env.MAX_LATE_FEE, 50), // the late fee never goes above this (pesos)
  lateGraceMinutes: num(process.env.LATE_GRACE_MINUTES, 15), // free minutes after the retrieval time
  arriveWindowMinutes: 15, // reservation expires if the helmet isn't stored this long after drop-off time
  maxAdvanceMinutes: 60, // how far ahead a reservation can start
  maxStorageHours: 12, // longest storage time
  noShowLimit: 3, // missed reservations before a block
  blockHours: 24, // how long the block lasts
};

// Secret the cabinet (ESP32) sends in the X-Locker-Key header
export const LOCKER_KEY = process.env.LOCKER_KEY || 'change-me-locker-key';

export const SMS = {
  driver: (process.env.SMS_DRIVER || 'log').toLowerCase(), // log | textbee | semaphore | android
  // textbee.dev: sends from the SIM of an Android phone you own (free plan: 300 texts a month)
  textbeeKey: process.env.SMS_TEXTBEE_KEY || '',
  textbeeDevice: process.env.SMS_TEXTBEE_DEVICE_ID || '',
  // semaphore.co: needs an approved Sender Name and paid credits
  semaphoreKey: process.env.SMS_SEMAPHORE_KEY || '',
  sender: process.env.SMS_SENDER || '',
  // a phone on the same WiFi as the server (only works when the server runs on your own network)
  androidUrl: process.env.SMS_ANDROID_URL || '',
  androidPath: process.env.SMS_ANDROID_PATH || '/message',
  androidUser: process.env.SMS_ANDROID_USER || '',
  androidPass: process.env.SMS_ANDROID_PASS || '',
};

export const RATE_LIMIT_MAX = num(process.env.RATE_LIMIT_MAX, 20); // login/register tries per minute per address
