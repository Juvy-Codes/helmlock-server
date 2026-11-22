// HelmLock pricing (same rules as the app's src/utils/pricing.js)
//   Drop-off (IN):   pesos paid when the helmet is stored
//   Retrieval (OUT): hourlyFee for every hour reserved
//   Late:            lateFeePerHour for every hour past the retrieval time (the first minutes are free)
import { RULES } from './config.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ms = (t) => (t instanceof Date ? t.getTime() : new Date(t).getTime());

// Whole hours reserved, rounded up (1 hr 10 min counts as 2 hours)
export function reservedHours(start, end) {
  return Math.max(1, Math.ceil((ms(end) - ms(start)) / HOUR - 1e-9));
}

// Are the lockers open at this moment? (OPEN_HOUR up to CLOSE_HOUR, Philippine time)
export function isOpenAt(at = Date.now()) {
  const d = new Date(ms(at));
  const hours = d.getHours() + d.getMinutes() / 60;
  return hours >= RULES.openHour && hours < RULES.closeHour;
}

// Minutes between two moments that fall INSIDE opening hours (closed hours do not count)
export function openMinutesBetween(from, to) {
  const a = ms(from);
  const b = ms(to);
  let total = 0;
  const day = new Date(a);
  day.setHours(0, 0, 0, 0);
  while (day.getTime() < b) {
    const open = new Date(day);
    open.setHours(RULES.openHour, 0, 0, 0);
    const close = new Date(day);
    close.setHours(RULES.closeHour, 0, 0, 0);
    const start = Math.max(a, open.getTime());
    const stop = Math.min(b, close.getTime());
    if (stop > start) total += (stop - start) / MIN;
    day.setDate(day.getDate() + 1);
  }
  return total;
}

// Hours charged as late. Only time while the lockers are OPEN counts.
// Nothing within the grace period, then every started hour counts.
export function lateHours(end, at = Date.now()) {
  const late = openMinutesBetween(end, at);
  if (late <= RULES.lateGraceMinutes) return 0;
  return Math.ceil(late / 60 - 1e-9);
}

// What a reservation costs now (or when it was retrieved)
export function feesFor(r, at = Date.now()) {
  const hours = reservedHours(r.start_time, r.end_time);
  const until = r.retrieved_at ? r.retrieved_at : at;
  const late = r.status === 'stored' || r.status === 'completed' ? lateHours(r.end_time, until) : 0;
  const retrieval = hours * RULES.hourlyFee;
  const lateFee = Math.min(late * RULES.lateFeePerHour, RULES.maxLateFee);
  return {
    hours,
    late_hours: late,
    drop_off: RULES.dropOffFee,
    retrieval,
    late_fee: lateFee,
    due_at_retrieval: retrieval + lateFee,
    total: RULES.dropOffFee + retrieval + lateFee,
  };
}
