import { z } from 'zod';
import { publicMenu, type Menu } from './menu';
import { recordDiagnostic } from './diagnostico';
import {
  accountLookupCondition, deliveryFees, deliveryOrder, fail, identifier, knownTableCount,
  pickupOrder, presentAccount, presentPayment, serviceSchema, tableOrder,
  type AccountLookup, type AccountRow, type Binding, type DeliveryDetails, type OrderService, type PaymentRow,
} from './comandas-servicio';

const LEASE_MS = 120_000;
const EXPIRED = 'Se perdió la confirmación del puente. Comprueba el papel y la cola de Windows.';
const MENU_CHANGED = 'La carta ha cambiado. Revisa los productos y precios antes de enviar.';
const AGENT_TOKEN = /^[A-Za-z0-9_-]{32,200}$/;
const CLAIM_TOKEN = /^[a-f0-9]{64}$/;

export const orderSchema = [
  `CREATE TABLE IF NOT EXISTS kitchen_orders (
    order_number INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    table_name TEXT NOT NULL,
    note TEXT NOT NULL,
    lines TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    request_payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS print_attempts (
    order_number INTEGER NOT NULL REFERENCES kitchen_orders(order_number),
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','printing','sent','failed','uncertain')),
    queued_at INTEGER NOT NULL,
    claim_token TEXT UNIQUE,
    lease_until INTEGER,
    completed_at INTEGER,
    print_error TEXT,
    PRIMARY KEY(order_number, attempt)
  )`,
  "CREATE INDEX IF NOT EXISTS print_pending ON print_attempts(queued_at, order_number) WHERE status='pending'",
  "CREATE UNIQUE INDEX IF NOT EXISTS print_single_active ON print_attempts(status) WHERE status='printing'",
  ...serviceSchema,
];

type PrintStatus = 'pending' | 'printing' | 'sent' | 'failed' | 'uncertain';

type OrderLine = {
  name: string;
  variant: string;
  quantity: number;
  note: string;
  unitCents: number;
};

type OrderRow = {
  order_number: number;
  id: string;
  table_name: string;
  note: string;
  lines: string;
  total_cents: number;
  created_at: string;
  request_payload: string;
  status: PrintStatus;
  attempt: number;
  print_error: string | null;
  service_kind: OrderService | null;
  table_number: number | null;
  account_number: number | null;
  reference: string | null;
  delivery_details: string | null;
  delivery_fee_cents: number | null;
};

const lineInput = z.object({
  itemId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  priceIndex: z.number().int().min(0).max(7),
  expectedCents: z.number().int().min(0).max(1_000_000),
  expectedVariant: z.string().max(80).optional(),
  quantity: z.number().int().min(1).max(99),
  note: z.string().trim().max(160).default(''),
}).strict();

const orderFields = {
  note: z.string().trim().max(300).default(''),
  menuRevision: z.number().int().nonnegative().optional(),
  lines: z.array(lineInput).min(1).max(50),
};

const orderInput = z.discriminatedUnion('service', [
  z.object({ id: identifier, ...tableOrder, ...orderFields }).strict(),
  z.object({ id: identifier, ...pickupOrder, ...orderFields }).strict(),
  z.object({ id: identifier, ...deliveryOrder, ...orderFields }).strict(),
]).or(z.object({
  id: identifier,
  table: z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u),
  ...orderFields,
}).strict());

const reprintInput = z.object({
  id: identifier,
  attempt: z.number().int().positive(),
}).strict();

const resultInput = z.object({
  id: identifier,
  claimToken: z.string().regex(CLAIM_TOKEN),
  status: z.enum(['sent', 'failed', 'uncertain']),
  error: z.string().trim().max(240).optional(),
}).strict();

const orderColumns = `o.*, p.status, p.attempt, p.print_error,
  s.kind AS service_kind, s.table_number, s.account_number, s.reference, s.delivery_details, s.delivery_fee_cents`;
const joinOrderService = 'LEFT JOIN kitchen_order_services s ON s.order_number=o.order_number';
const selectedOrder = `SELECT ${orderColumns}
  FROM kitchen_orders o
  JOIN print_attempts p ON p.order_number=o.order_number AND p.attempt=(
    SELECT MAX(history.attempt) FROM print_attempts history WHERE history.order_number=o.order_number
  ) ${joinOrderService}`;

function present(row: OrderRow) {
  return {
    id: row.id,
    number: row.order_number,
    table: row.table_name,
    note: row.note,
    lines: JSON.parse(row.lines) as OrderLine[],
    service: row.service_kind,
    tableNumber: row.table_number,
    accountNumber: row.account_number,
    reference: row.reference,
    delivery: row.delivery_details ? JSON.parse(row.delivery_details) as DeliveryDetails : null,
    subtotalCents: row.total_cents - (row.delivery_fee_cents ?? 0),
    deliveryFeeCents: row.delivery_fee_cents ?? 0,
    totalCents: row.total_cents,
    createdAt: row.created_at,
    status: row.status,
    attempt: row.attempt,
    printError: row.print_error,
  };
}

function readOrder(db: Binding, id: string) {
  return db.prepare(selectedOrder + ' WHERE o.id=?').bind(id);
}

function checkRequestMatch(row: OrderRow, requestPayload: string) {
  if (row.request_payload !== requestPayload) fail('Este identificador ya pertenece a otra comanda.', 409);
}

function snapshotLines(menu: Menu, selection: z.infer<typeof lineInput>[]) {
  const available = new Map(publicMenu(menu).items.map(item => [item.id, item]));
  const lines: OrderLine[] = [];
  for (const line of selection) {
    const item = available.get(line.itemId);
    const price = item?.prices[line.priceIndex];
    if (!item || !price || price.cents !== line.expectedCents ||
        (line.expectedVariant !== undefined && line.expectedVariant !== price.label)) return null;
    lines.push({
      name: item.name,
      variant: price.label,
      quantity: line.quantity,
      note: line.note,
      unitCents: price.cents,
    });
  }
  return lines;
}

function expireClaims(db: Binding, now: number) {
  return db.prepare(
    "UPDATE print_attempts SET status='uncertain', print_error=? WHERE status='printing' AND lease_until<=? RETURNING order_number",
  ).bind(EXPIRED, now);
}

async function reportExpiredClaim(db: Binding, rows: { order_number: number }[]) {
  if (rows[0]) await recordDiagnostic(db, 'print_lease_expired', rows[0].order_number);
}

export async function expirePrintLease(db: Binding) {
  const [expired] = await db.batch<{ order_number: number }>([expireClaims(db, Date.now())]);
  await reportExpiredClaim(db, expired.results);
}

export async function listOrders(db: Binding) {
  const [expired, history] = await db.batch<OrderRow>([
    expireClaims(db, Date.now()),
    db.prepare(selectedOrder + ' ORDER BY o.order_number DESC LIMIT 50'),
  ]);
  await reportExpiredClaim(db, expired.results);
  return history.results.map(present);
}

export async function accountDetails(db: Binding, lookup: AccountLookup) {
  const { sql, value } = accountLookupCondition(lookup);
  const [account, orders, payments] = await db.batch([
    db.prepare(`SELECT a.* FROM service_accounts a WHERE ${sql}`).bind(value),
    db.prepare(`${selectedOrder} JOIN service_accounts a ON a.account_number=s.account_number
      WHERE ${sql} ORDER BY o.order_number`).bind(value),
    db.prepare(`SELECT p.*, a.id AS account_id FROM table_payments p
      JOIN service_accounts a ON a.account_number=p.account_number WHERE ${sql} ORDER BY p.account_version`).bind(value),
  ]);
  if (!account.results[0]) return null;
  return {
    ...presentAccount(account.results[0] as AccountRow),
    orders: (orders.results as OrderRow[]).map(present),
    payments: (payments.results as PaymentRow[]).map(presentPayment),
  };
}

export async function createOrder(
  db: Binding,
  input: unknown,
  getMenu: () => Promise<{ menu: Menu; revision: number }>,
) {
  const parsed = orderInput.safeParse(input);
  if (!parsed.success) fail('Revisa el servicio, los datos del pedido, los productos y las cantidades.');
  const order = parsed.data;
  const requestPayload = JSON.stringify(order);
  const previous = await readOrder(db, order.id).first<OrderRow>();
  if (previous) {
    checkRequestMatch(previous, requestPayload);
    return { order: present(previous), created: false };
  }

  const { menu, revision } = await getMenu();
  const lines = order.menuRevision === undefined || order.menuRevision === revision
    ? snapshotLines(menu, order.lines)
    : null;
  if (!lines) {
    // A concurrent retry may have saved this identifier just before the menu changed.
    const concurrent = await readOrder(db, order.id).first<OrderRow>();
    if (!concurrent) fail(MENU_CHANGED, 409, 'MENU_CHANGED');
    checkRequestMatch(concurrent, requestPayload);
    return { order: present(concurrent), created: false };
  }
  const service = 'service' in order ? order : null;
  const delivery = service?.service === 'delivery' ? service.delivery : null;
  const deliveryFeeCents = delivery ? deliveryFees[delivery.zone] : 0;
  const totalCents = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, deliveryFeeCents);
  if (delivery?.cashCents != null && delivery.cashCents < totalCents) {
    fail('El efectivo indicado debe cubrir el total del pedido, incluido el reparto.', 400, 'CASH_TOO_LOW');
  }
  const now = new Date();
  const createdAt = now.toISOString();
  const table = service?.service === 'table' ? service : null;
  const label = 'table' in order ? order.table : table ? `Mesa ${table.tableNumber}` : delivery ? 'A domicilio' : 'Para recoger';
  const tableGuard = table ? {
    sql: `AND ?<=${knownTableCount} AND ? IS (
      SELECT id FROM service_accounts WHERE table_number=? AND closed_at IS NULL
    )`,
    binding: [table.tableNumber, table.expectedAccountId, table.tableNumber],
  } : { sql: '', binding: [] };
  const unlinked = `SELECT o.order_number FROM kitchen_orders o WHERE o.id=? AND o.request_payload=?
    AND NOT EXISTS (SELECT 1 FROM kitchen_order_services s WHERE s.order_number=o.order_number)`;
  const accountId = table?.expectedAccountId ?? order.id;
  const serviceStatements = service ? [
    db.prepare(
      `INSERT INTO service_accounts(id, table_number, opened_at)
       SELECT ?, ?, ? WHERE EXISTS (${unlinked}) ON CONFLICT(id) DO NOTHING`,
    ).bind(accountId, table?.tableNumber ?? null, createdAt, order.id, requestPayload),
    db.prepare(
      `UPDATE service_accounts SET total_cents=total_cents+?,version=version+1
       WHERE id=? AND EXISTS (${unlinked})`,
    ).bind(totalCents, accountId, order.id, requestPayload),
    db.prepare(
      `INSERT INTO kitchen_order_services(order_number, account_number, kind, table_number, reference, delivery_details, delivery_fee_cents)
       SELECT o.order_number, a.account_number, ?, ?, ?, ?, ? FROM kitchen_orders o
       JOIN service_accounts a ON a.id=? WHERE o.id=? AND o.request_payload=?
       ON CONFLICT(order_number) DO NOTHING`,
    ).bind(service.service, table?.tableNumber ?? null, service.service === 'pickup' ? service.reference || null : null,
      delivery ? JSON.stringify(delivery) : null, deliveryFeeCents, accountId, order.id, requestPayload),
  ] : [];
  const results = await db.batch<OrderRow>([
    db.prepare(
      `INSERT INTO kitchen_orders(id, table_name, note, lines, total_cents, created_at, request_payload)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT revision FROM menu_document WHERE id=1), 0)=? ${tableGuard.sql}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(order.id, label, order.note, JSON.stringify(lines), totalCents, createdAt, requestPayload, revision, ...tableGuard.binding),
    ...serviceStatements,
    db.prepare(
      `INSERT INTO print_attempts (order_number, attempt, status, queued_at)
       SELECT order_number, 1, 'pending', ? FROM kitchen_orders WHERE id=? AND request_payload=?
       ON CONFLICT(order_number, attempt) DO NOTHING`,
    ).bind(now.getTime(), order.id, requestPayload),
    readOrder(db, order.id),
  ]);
  const stored = results.at(-1)?.results[0];
  if (!stored) {
    if (table) {
      const current = await db.prepare('SELECT COALESCE((SELECT revision FROM menu_document WHERE id=1), 0) AS revision').first<{ revision: number }>();
      if (current?.revision === revision) {
        fail('La mesa ha cambiado. Confirma la mesa y la cuenta actual antes de enviar.', 409, 'TABLE_CHANGED');
      }
    }
    fail(MENU_CHANGED, 409, 'MENU_CHANGED');
  }
  checkRequestMatch(stored, requestPayload);
  return { order: present(stored), created: results[0].meta.changes === 1 };
}

export async function reprintOrder(db: Binding, input: unknown) {
  const parsed = reprintInput.safeParse(input);
  if (!parsed.success) fail('La comanda no es válida.');
  const { id, attempt } = parsed.data;
  const now = Date.now();
  const [expired, insert, selected] = await db.batch<OrderRow>([
    expireClaims(db, now),
    db.prepare(
      `INSERT INTO print_attempts (order_number, attempt, status, queued_at)
       SELECT p.order_number, p.attempt+1, 'pending', ?
       FROM print_attempts p JOIN kitchen_orders o ON o.order_number=p.order_number
       WHERE o.id=? AND p.attempt=? AND p.status IN ('sent','failed','uncertain')
         AND NOT EXISTS (
           SELECT 1 FROM print_attempts history
           WHERE history.order_number=p.order_number AND history.attempt>p.attempt
         )
       ON CONFLICT(order_number, attempt) DO NOTHING`,
    ).bind(now, id, attempt),
    readOrder(db, id),
  ]);
  await reportExpiredClaim(db, expired.results);
  const row = selected.results[0];
  if (!row) fail('Comanda no encontrada.', 404);
  if (insert.meta.changes !== 1) fail('La cola ha cambiado. Actualiza las comandas antes de reimprimir.', 409);
  return present(row);
}

export async function authenticatePrinter(request: Request, expected: unknown) {
  if (typeof expected !== 'string' || !AGENT_TOKEN.test(expected)) {
    fail('Falta configurar la credencial del puente de impresión.', 503);
  }
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/i)?.[1];
  if (!supplied) fail('Credencial del puente incorrecta.', 401);
  const encoder = new TextEncoder();
  const hashes = await Promise.all([supplied, expected].map(async token =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))),
  ));
  let difference = 0;
  for (let index = 0; index < hashes[0].length; index++) {
    difference |= hashes[0][index] ^ hashes[1][index];
  }
  if (difference !== 0) fail('Credencial del puente incorrecta.', 401);
}

export async function claimPrintJob(db: Binding, claimToken: string) {
  const now = Date.now();
  const [expired, , selected] = await db.batch<OrderRow>([
    expireClaims(db, now),
    db.prepare(
      `UPDATE print_attempts SET status='printing', claim_token=?, lease_until=?
       WHERE (order_number, attempt)=(
         SELECT order_number, attempt FROM print_attempts
         WHERE status='pending' ORDER BY queued_at, order_number LIMIT 1
       ) AND NOT EXISTS (SELECT 1 FROM print_attempts WHERE status='printing')`,
    ).bind(claimToken, now + LEASE_MS),
    db.prepare(
      `SELECT ${orderColumns}
       FROM print_attempts p JOIN kitchen_orders o ON o.order_number=p.order_number ${joinOrderService}
       WHERE p.claim_token=?`,
    ).bind(claimToken),
  ]);
  await reportExpiredClaim(db, expired.results);
  const row = selected.results[0];
  return row ? { ...present(row), claimToken, isCopy: row.attempt > 1 } : null;
}

export async function finishPrintJob(db: Binding, input: unknown) {
  const parsed = resultInput.safeParse(input);
  if (!parsed.success) fail('Resultado de impresión no válido.');
  const { id, claimToken, status, error } = parsed.data;
  const printError = status === 'sent' ? null : error ||
    (status === 'failed' ? 'Windows no pudo recibir la comanda.' : 'No se pudo confirmar el envío a Windows.');
  const [completed, selected] = await db.batch<{ order_number: number; status: PrintStatus; print_error: string | null }>([
    db.prepare(
      `UPDATE print_attempts SET status=?, print_error=?, completed_at=?
       WHERE claim_token=? AND order_number=(SELECT order_number FROM kitchen_orders WHERE id=?)
         AND status IN ('printing','uncertain') AND completed_at IS NULL`,
    ).bind(status, printError, Date.now(), claimToken, id),
    db.prepare(
      `SELECT order_number, status, print_error FROM print_attempts
       WHERE claim_token=? AND order_number=(SELECT order_number FROM kitchen_orders WHERE id=?)
         AND completed_at IS NOT NULL`,
    ).bind(claimToken, id),
  ]);
  const row = selected.results[0];
  if (!row || row.status !== status || row.print_error !== printError) {
    fail('Este resultado no corresponde a un intento pendiente.', 409);
  }
  return { completed: completed.meta.changes === 1, status, orderNumber: row.order_number };
}
