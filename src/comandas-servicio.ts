import { z } from 'zod';

const DEFAULT_TABLE_COUNT = 14;
const MAX_TABLE_COUNT = 100;

export const serviceSchema = [
  `CREATE TABLE IF NOT EXISTS table_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    table_count INTEGER NOT NULL CHECK(table_count BETWEEN 1 AND ${MAX_TABLE_COUNT})
  )`,
  `CREATE TABLE IF NOT EXISTS service_accounts (
    account_number INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    table_number INTEGER CHECK(table_number BETWEEN 1 AND ${MAX_TABLE_COUNT}),
    version INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents BETWEEN 0 AND total_cents),
    opened_at TEXT NOT NULL,
    closed_at TEXT
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS unique_open_table ON service_accounts(table_number) WHERE closed_at IS NULL AND table_number IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS kitchen_order_services (
    order_number INTEGER PRIMARY KEY REFERENCES kitchen_orders(order_number),
    account_number INTEGER NOT NULL REFERENCES service_accounts(account_number),
    kind TEXT NOT NULL CHECK(kind IN ('table','pickup','delivery')),
    table_number INTEGER,
    reference TEXT,
    delivery_details TEXT,
    delivery_fee_cents INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS services_by_account ON kitchen_order_services(account_number, order_number)',
  `CREATE TABLE IF NOT EXISTS table_payments (
    id TEXT PRIMARY KEY,
    account_number INTEGER NOT NULL REFERENCES service_accounts(account_number),
    account_version INTEGER NOT NULL,
    cents INTEGER NOT NULL CHECK(cents>=0),
    method TEXT NOT NULL CHECK(method IN ('cash','card')),
    created_at TEXT NOT NULL,
    UNIQUE(account_number, account_version)
  )`,
];

export type Statement = {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
};

export type Binding = {
  prepare(sql: string): Statement;
  batch<T = unknown>(statements: Statement[]): Promise<{ results: T[]; meta: { changes: number } }[]>;
};

export function fail(message: string, status = 400, code?: string): never {
  throw Object.assign(new Error(message), { status, code });
}

export const identifier = z.string().uuid();
const tableNumber = z.number().int().min(1).max(MAX_TABLE_COUNT);
const singleLine = /^[^\u0000-\u001f\u007f-\u009f]*$/u;
const phone = z.string().trim().max(32).regex(/^\+?[0-9 ()\-.]+$/).refine(value => /^\d{7,15}$/.test(value.replace(/\D/g, '')));

export const tableOrder = {
  service: z.literal('table'),
  tableNumber,
  expectedAccountId: identifier.nullable(),
};

export const pickupOrder = {
  service: z.literal('pickup'),
  reference: z.string().trim().max(80).regex(singleLine).optional(),
};

const deliveryDetails = z.object({
  zone: z.enum(['la-barca', 'mc']),
  address: z.string().trim().min(1).max(200).regex(singleLine),
  phone,
  payment: z.enum(['change', 'card', 'exact']),
  cashCents: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullish(),
}).strict().refine(delivery => delivery.cashCents == null || delivery.payment === 'change');

export type DeliveryDetails = z.infer<typeof deliveryDetails>;
export type OrderService = 'table' | 'pickup' | 'delivery';
export const deliveryOrder = { service: z.literal('delivery'), delivery: deliveryDetails };
export const deliveryFees = { 'la-barca': 200, mc: 300 } as const;

export type AccountRow = {
  account_number: number;
  id: string;
  table_number: number;
  version: number;
  total_cents: number;
  paid_cents: number;
  closed_at: string | null;
};

export type PaymentRow = {
  id: string;
  account_version: number;
  cents: number;
  method: 'cash' | 'card';
  created_at: string;
  account_id: string;
};

export function presentAccount(row: AccountRow) {
  return {
    id: row.id,
    number: row.account_number,
    tableNumber: row.table_number,
    version: row.version,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    remainingCents: row.total_cents - row.paid_cents,
    closedAt: row.closed_at,
  };
}

export function presentPayment(row: PaymentRow) {
  return { id: row.id, cents: row.cents, method: row.method, createdAt: row.created_at };
}

export type AccountLookup = { table: number } | { id: string };

export function tableAccountLookup(input: string | null): AccountLookup {
  const parsed = tableNumber.safeParse(input === null ? NaN : Number(input));
  if (!parsed.success) fail('La mesa indicada no es válida.');
  return { table: parsed.data };
}

export function accountLookupCondition(lookup: AccountLookup) {
  return 'table' in lookup
    ? { sql: 'a.table_number=? AND a.closed_at IS NULL', value: lookup.table }
    : { sql: 'a.id=? AND a.table_number IS NOT NULL', value: lookup.id };
}

export const knownTableCount = `COALESCE((SELECT table_count FROM table_settings WHERE id=1), ${DEFAULT_TABLE_COUNT})`;

export async function listTables(db: Binding) {
  const [settings, active] = await db.batch([
    db.prepare(`SELECT ${knownTableCount} AS count`),
    db.prepare('SELECT * FROM service_accounts WHERE closed_at IS NULL AND table_number IS NOT NULL'),
  ]);
  const tableCount = (settings.results[0] as { count: number }).count;
  const accounts = new Map((active.results as AccountRow[]).map(row => [row.table_number, presentAccount(row)]));
  const tables = Array.from({ length: tableCount }, (_, index) => ({
    number: index + 1,
    account: accounts.get(index + 1) ?? null,
  }));
  return { tableCount, tables };
}

export async function setTableCount(db: Binding, input: unknown) {
  const parsed = z.object({ count: tableNumber }).strict().safeParse(input);
  if (!parsed.success) fail(`Indica un número de mesas entre 1 y ${MAX_TABLE_COUNT}.`);
  const { count } = parsed.data;
  const result = await db.prepare(
    `INSERT INTO table_settings (id,table_count)
     SELECT 1, ? WHERE NOT EXISTS (
       SELECT 1 FROM service_accounts WHERE closed_at IS NULL AND table_number>?
     ) ON CONFLICT(id) DO UPDATE SET table_count=excluded.table_count RETURNING table_count`,
  ).bind(count, count).first();
  if (!result) fail('Hay mesas ocupadas que quedarían fuera del panel. Cobra esas cuentas primero.', 409);
  return listTables(db);
}

const paymentInput = z.object({
  id: identifier,
  accountId: identifier,
  version: z.number().int().positive(),
  cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  method: z.enum(['cash', 'card']),
}).strict();

export async function recordTablePayment(db: Binding, input: unknown): Promise<AccountLookup> {
  const parsed = paymentInput.safeParse(input);
  if (!parsed.success) fail('Revisa el importe y la forma de pago.');
  const { id, accountId, version, cents, method } = parsed.data;
  const now = new Date().toISOString();
  const [, , selected] = await db.batch<PaymentRow>([
    db.prepare(
      `INSERT INTO table_payments(id,account_number,account_version,cents,method,created_at)
       SELECT ?, account_number, version, ?, ?, ? FROM service_accounts
       WHERE id=? AND table_number IS NOT NULL AND closed_at IS NULL AND version=?
         AND ((?>0 AND ?<=total_cents-paid_cents) OR (?=0 AND total_cents=paid_cents))
       ON CONFLICT(id) DO NOTHING`,
    ).bind(id, cents, method, now, accountId, version, cents, cents, cents),
    db.prepare(
      `UPDATE service_accounts SET paid_cents=paid_cents+?, version=version+1,
         closed_at=CASE WHEN paid_cents+?=total_cents THEN ? ELSE NULL END
       WHERE id=? AND version=? AND closed_at IS NULL AND EXISTS (
         SELECT 1 FROM table_payments p WHERE p.id=? AND p.account_number=service_accounts.account_number
           AND p.account_version=? AND p.cents=? AND p.method=?
       )`,
    ).bind(cents, cents, now, accountId, version, id, version, cents, method),
    db.prepare(
      'SELECT p.*, a.id AS account_id FROM table_payments p JOIN service_accounts a ON a.account_number=p.account_number WHERE p.id=?',
    ).bind(id),
  ]);
  const payment = selected.results[0];
  if (!payment) fail('La cuenta ha cambiado o el importe supera lo pendiente. Actualiza la cuenta antes de cobrar.', 409, 'ACCOUNT_CHANGED');
  if (payment.account_id !== accountId || payment.account_version !== version || payment.cents !== cents || payment.method !== method) {
    fail('Este identificador ya pertenece a otro cobro.', 409, 'ACCOUNT_CHANGED');
  }
  return { id: accountId };
}
