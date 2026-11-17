// The database. Everything lives in one object in memory and is saved after every change.
//
//   DATABASE_URL set  -> saved in an online Postgres (Neon, Supabase, Render...). Use this when hosting online,
//                        because free hosts wipe local files on every restart.
//   DATABASE_URL empty -> saved in the file data/db.json (fine on your laptop).
//
// Only ONE copy of the server may run at a time (two copies would overwrite each other).
import fs from 'node:fs';
import path from 'node:path';

export const DB_FILE = process.env.DB_FILE || path.join(process.cwd(), 'data', 'db.json');
export const STORAGE = process.env.DATABASE_URL ? 'postgres' : 'file';

export const db = {
  meta: { lastId: 1000 },
  users: [],
  lockers: [],
  reservations: [],
  qrCodes: [],
  reports: [],
  logs: [],
  tokens: [],
  resetCodes: [],
  smsLog: [],
};

export const newId = () => ++db.meta.lastId;

let pool = null;

// Call once at start. Returns true when saved data was found and loaded.
export async function init() {
  if (STORAGE === 'postgres') {
    const pg = (await import('pg')).default;
    const url = process.env.DATABASE_URL;
    const local = /@(localhost|127\.0\.0\.1)/.test(url);
    pool = new pg.Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
    await pool.query('create table if not exists helmlock_state (id int primary key, data jsonb not null, updated_at timestamptz not null default now())');
    const res = await pool.query('select data from helmlock_state where id = 1');
    if (!res.rows[0]) return false;
    Object.assign(db, res.rows[0].data);
    return true;
  }
  if (!fs.existsSync(DB_FILE)) return false;
  Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  return true;
}

// One save at a time; if changes arrive while saving, save once more afterwards
let saving = false;
let again = false;

export async function saveNow() {
  if (STORAGE === 'postgres') {
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    try {
      do {
        again = false;
        await pool.query(
          'insert into helmlock_state (id, data, updated_at) values (1, $1::jsonb, now()) on conflict (id) do update set data = excluded.data, updated_at = now()',
          [JSON.stringify(db)],
        );
      } while (again);
    } finally {
      saving = false;
    }
    return;
  }
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

let timer = null;
export function scheduleSave() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    saveNow().catch((e) => console.error('Could not save the database:', e.message));
  }, 150);
  timer.unref?.();
}

export async function closeStore() {
  await saveNow();
  await pool?.end();
}
