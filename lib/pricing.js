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

// Hours charged as late. Nothing within the grace period, then every started hour counts.
export function lateHours(end, at = Date.now()) {
  const late = (ms(at) - ms(end)) / MIN;
  if (late <= RULES.lateGraceMinutes) return 0;
  return Math.ceil(late / 60 - 1e-9);
}

// What a reservation costs now (or when it was retrieved)
export function feesFor(r, at = Date.now()) {
  const hours = reservedHours(r.start_time, r.end_time);
  const until = r.retrieved_at ? r.retrieved_at : at;
  const late = r.status === 'stored' || r.status === 'completed' ? lateHours(r.end_time, until) : 0;
  const retrieval = hours * RULES.hourlyFee;
  const lateFee = late * RULES.lateFeePerHour;
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
