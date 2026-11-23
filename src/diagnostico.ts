import { z } from 'zod';
import { fail, type Binding } from './comandas-servicio';

const USERNAME = 'LaGlotona';
const COOKIE = '__Host-punto-cero-logs';
const HASH = /^pbkdf2-sha256\$100000\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const PBKDF2_ITERATIONS = 100_000;
const SESSION_SECONDS = 8 * 60 * 60;
const THROTTLE_WINDOW = 15 * 60_000;
const THROTTLE_LIMIT = 5;
const BRIDGE_STALE = 150_000;
const RETENTION = 30 * 24 * 60 * 60_000;
const encoder = new TextEncoder();

const schema = [
  `CREATE TABLE IF NOT EXISTS diagnostic_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    code TEXT NOT NULL,
    order_number INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS diagnostic_event_time ON diagnostic_events(at)',
  'CREATE INDEX IF NOT EXISTS diagnostic_event_code ON diagnostic_events(code,source,at)',
  `CREATE TABLE IF NOT EXISTS diagnostic_bridge (
    id INTEGER PRIMARY KEY CHECK(id=1),
    state TEXT NOT NULL CHECK(state IN ('ready','unavailable')),
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diagnostic_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS diagnostic_login_attempts (
    ip_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
];

const events = {
  order_queued: ['info', 'web'],
  order_reprint_queued: ['info', 'web'],
  order_claimed: ['info', 'printer'],
  print_sent: ['info', 'printer'],
  print_failed: ['error', 'printer'],
  print_uncertain: ['warn', 'printer'],
  print_lease_expired: ['warn', 'printer'],
  worker_error: ['error', 'web'],
  bridge_online: ['info', 'printer'],
  bridge_printer_unavailable: ['warn', 'printer'],
  bridge_printer_ready: ['info', 'printer'],
  bridge_claim_unreachable: ['warn', 'printer'],
  bridge_result_unreachable: ['warn', 'printer'],
  bridge_ack_conflict: ['warn', 'printer'],
  logs_login_failed: ['warn', 'auth'],
  logs_login_success: ['info', 'auth'],
  logs_login_rate_limited: ['warn', 'auth'],
} as const;

type EventCode = keyof typeof events;
type Source = typeof events[EventCode][1];
type EventRow = { id: number; at: number; level: string; source: Source; code: EventCode; order_number: number | null };
type BridgeRow = { state: 'ready' | 'unavailable'; last_seen_at: number };
type QueueRow = { pending: number; printing: number; oldest_pending_at: number | null };

let schemaReady: Promise<unknown> | null = null;
let nextCleanupAt = 0;

function prepare(db: Binding) {
  if (!schemaReady) {
    schemaReady = db.batch(schema.map(sql => db.prepare(sql))).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function cleanExpired(db: Binding, now: number) {
  if (now < nextCleanupAt) return;
  nextCleanupAt = now + 60 * 60_000;
  try {
    await db.batch([
      db.prepare('DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events WHERE at<? LIMIT 1000)').bind(now - RETENTION),
      db.prepare('DELETE FROM diagnostic_sessions WHERE rowid IN (SELECT rowid FROM diagnostic_sessions WHERE expires_at<=? LIMIT 1000)').bind(now),
      db.prepare('DELETE FROM diagnostic_login_attempts WHERE rowid IN (SELECT rowid FROM diagnostic_login_attempts WHERE expires_at<=? LIMIT 1000)').bind(now),
    ]);
  } catch {
    // The query still applies retention even if cleanup has to wait.
  }
}

export async function recordDiagnostic(db: Binding | undefined, code: EventCode, orderNumber: number | null = null, sourceOverride?: Source) {
  if (!db) return;
  try {
    await prepare(db);
    const [level, defaultSource] = events[code];
    const source = sourceOverride ?? defaultSource;
    const now = Date.now();
    const deduplicate = code === 'worker_error' || code === 'logs_login_rate_limited' || code.endsWith('_unreachable') || code === 'bridge_ack_conflict';
    const sql = `INSERT INTO diagnostic_events(at,level,source,code,order_number) SELECT ?,?,?,?,?`;
    const write = deduplicate
      ? db.prepare(`${sql} WHERE NOT EXISTS (SELECT 1 FROM diagnostic_events WHERE code=? AND source=? AND at>?)`)
        .bind(now, level, source, code, orderNumber, code, source, now - 60_000)
      : db.prepare(sql).bind(now, level, source, code, orderNumber);
    await db.batch([write]);
    await cleanExpired(db, now);
  } catch {
    // Monitoring failures must never affect orders, account changes or printing.
  }
}

function asHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

async function digest(value: string) {
  return asHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

type PasswordVerifier = { secret: string; salt: string; expected: string };

function verifier(secret: unknown): PasswordVerifier | null {
  if (typeof secret !== 'string') return null;
  const match = HASH.exec(secret);
  return match ? { secret, salt: match[1], expected: match[2] } : null;
}

async function checkPassword(password: string, { salt, expected }: PasswordVerifier) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: PBKDF2_ITERATIONS }, key, 256,
  );
  const actual = new Uint8Array(bits);
  const reference = fromHex(expected);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ reference[index];
  return difference === 0;
}

function sessionToken(request: Request) {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-punto-cero-logs=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function sessionHash(value: string, secret: string) {
  return digest(`logs-session:${secret}:${value}`);
}

function cookieHeader(value: string, seconds: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}

export async function diagnosticSession(request: Request, db: Binding | undefined, secret: unknown) {
  const credentials = verifier(secret);
  if (!db || !credentials) return { authenticated: false, configured: false };
  const token = sessionToken(request);
  if (!token) return { authenticated: false, configured: true };
  await prepare(db);
  const row = await db.prepare('SELECT 1 FROM diagnostic_sessions WHERE token_hash=? AND expires_at>?')
    .bind(await sessionHash(token, credentials.secret), Date.now()).first();
  return { authenticated: Boolean(row), configured: true };
}

const loginInput = z.object({ username: z.string().max(100), password: z.string().min(1).max(512) }).strict();

export async function diagnosticLogin(request: Request, db: Binding | undefined, secret: unknown, input: unknown) {
  const credentials = verifier(secret);
  if (!db || !credentials) fail('Falta configurar el acceso al diagnóstico.', 503);
  const parsed = loginInput.safeParse(input);
  if (!parsed.success) fail('Introduce un usuario y una contraseña válidos.');
  await prepare(db);
  const now = Date.now();
  const ip = await digest(`logs-attempt:${credentials.secret}:${request.headers.get('cf-connecting-ip') || 'local'}`);
  const rate = await db.prepare(
    `INSERT INTO diagnostic_login_attempts(ip_hash,attempts,expires_at) VALUES (?,1,?)
     ON CONFLICT(ip_hash) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,
       expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
     WHERE attempts<=? OR expires_at<=? RETURNING attempts`,
  ).bind(ip, now + THROTTLE_WINDOW, now, now, THROTTLE_LIMIT, now).first<{ attempts: number }>();
  if (!rate || rate.attempts > THROTTLE_LIMIT) {
    if (rate) await recordDiagnostic(db, 'logs_login_rate_limited');
    fail('Demasiados intentos. Vuelve a intentarlo dentro de 15 minutos.', 429);
  }
  const valid = await checkPassword(parsed.data.password, credentials);
  if (!valid || parsed.data.username !== USERNAME) {
    await recordDiagnostic(db, 'logs_login_failed');
    fail('El usuario o la contraseña no son correctos.', 401);
  }
  const token = asHex(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare('DELETE FROM diagnostic_login_attempts WHERE ip_hash=?').bind(ip),
    db.prepare('INSERT INTO diagnostic_sessions(token_hash,expires_at) VALUES (?,?)')
      .bind(await sessionHash(token, credentials.secret), now + SESSION_SECONDS * 1000),
  ]);
  await recordDiagnostic(db, 'logs_login_success');
  return cookieHeader(token, SESSION_SECONDS);
}

export async function diagnosticLogout(request: Request, db: Binding | undefined, secret: unknown) {
  const credentials = verifier(secret);
  const token = sessionToken(request);
  if (db && credentials && token) {
    await prepare(db);
    await db.batch([db.prepare('DELETE FROM diagnostic_sessions WHERE token_hash=?').bind(await sessionHash(token, credentials.secret))]);
  }
  return cookieHeader('', 0);
}

const telemetry = z.object({
  state: z.enum(['ready', 'unavailable']),
  event: z.enum(['bridge_claim_unreachable', 'bridge_result_unreachable', 'bridge_ack_conflict']).optional(),
}).strict();

export async function bridgeTelemetry(db: Binding, input: unknown) {
  const parsed = telemetry.safeParse(input);
  if (!parsed.success) fail('Señal del puente no válida.');
  await prepare(db);
  const { state, event } = parsed.data;
  const now = Date.now();
  const [old] = await db.batch<BridgeRow>([
    db.prepare('SELECT state,last_seen_at FROM diagnostic_bridge WHERE id=1'),
    db.prepare(`INSERT INTO diagnostic_bridge(id,state,last_seen_at) VALUES (1,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,last_seen_at=excluded.last_seen_at
      WHERE excluded.last_seen_at>=diagnostic_bridge.last_seen_at`).bind(state, now),
  ]);
  const previous = old.results[0];
  const stale = !previous || now - previous.last_seen_at > BRIDGE_STALE;
  if (stale || previous.state !== state) {
    const code = state === 'unavailable' ? 'bridge_printer_unavailable' : stale ? 'bridge_online' : 'bridge_printer_ready';
    await recordDiagnostic(db, code);
  }
  if (event) await recordDiagnostic(db, event);
}

const filters = z.object({
  level: z.enum(['error', 'warn', 'info']).nullable(),
  source: z.enum(['web', 'printer', 'auth']).nullable(),
});

export async function readDiagnostics(db: Binding, query: URLSearchParams) {
  const parsed = filters.safeParse({ level: query.get('level'), source: query.get('source') });
  if (!parsed.success) fail('Los filtros de diagnóstico no son válidos.');
  const { level, source } = parsed.data;
  const now = Date.now();
  const [journal, bridge, queue] = await db.batch([
    db.prepare(`SELECT id,at,level,source,code,order_number FROM diagnostic_events WHERE at>=?
      AND (? IS NULL OR level=?) AND (? IS NULL OR source=?) ORDER BY at DESC,id DESC LIMIT 100`)
      .bind(now - RETENTION, level, level, source, source),
    db.prepare('SELECT state,last_seen_at FROM diagnostic_bridge WHERE id=1'),
    db.prepare(`SELECT COUNT(CASE WHEN status='pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status='printing' AND lease_until>? THEN 1 END) AS printing,
      MIN(CASE WHEN status='pending' THEN queued_at END) AS oldest_pending_at
      FROM print_attempts WHERE status IN ('pending','printing')`).bind(now),
  ]);
  const current = bridge.results[0] as BridgeRow | undefined;
  const counters = queue.results[0] as QueueRow;
  const status = !current ? 'unknown' : now - current.last_seen_at > BRIDGE_STALE ? 'offline'
    : current.state === 'ready' ? 'online' : 'unavailable';
  await cleanExpired(db, now);
  return {
    events: (journal.results as EventRow[]).map(row => ({ id: row.id, at: new Date(row.at).toISOString(),
      level: row.level, source: row.source, code: row.code, orderNumber: row.order_number,
    })),
    health: {
      bridge: { status, lastSeenAt: current ? new Date(current.last_seen_at).toISOString() : null },
      queue: { pending: counters.pending, printing: counters.printing,
        oldestPendingAt: counters.oldest_pending_at === null ? null : new Date(counters.oldest_pending_at).toISOString(),
      },
    },
  };
}
