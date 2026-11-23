import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const site = 'https://punto-cero-diagnostico-test.pages.dev';
const pass = 'diagnostico-solo-pruebas-872';
const ownerCode = 'PRUEBA-PROPIETARIA';
const printerToken = 'telemetria-pruebas-' + 'x'.repeat(45);
const salt = Buffer.alloc(16, 11);
const verifier = `pbkdf2-sha256$100000$${salt.toString('hex')}$${pbkdf2Sync(pass, salt, 100_000, 32, 'sha256').toString('hex')}`;
const browser = { Origin: site, 'X-Punto-Cero': 'editar', 'CF-Connecting-IP': '192.0.2.41' };
const printer = { Authorization: `Bearer ${printerToken}` };

function fixture(configured = true) {
  const worker = new Miniflare({
    modules: true,
    scriptPath: 'dist/_worker.js',
    compatibilityDate: '2026-05-01',
    cf: false,
    d1Databases: { DB: 'logs-test' },
    bindings: {
      ADMIN_CODE_HASH: createHash('sha256').update(ownerCode).digest('hex'),
      PRINT_AGENT_TOKEN: printerToken,
      ...(configured ? { LOG_ADMIN_PASSWORD_HASH: verifier } : {}),
    },
  });
  const call = (path, { body, headers = {} } = {}) => worker.dispatchFetch(`${site}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { worker, call };
}

test('el diagnóstico deniega el acceso cuando falta el secreto', async () => {
  const { worker, call } = fixture(false);
  try {
    const session = await call('logs/session');
    assert.deepEqual(await session.json(), { authenticated: false, configured: false });
    assert.equal((await call('logs')).status, 401);
    assert.equal((await call('logs/login', { body: { username: 'LaGlotona', password: pass }, headers: browser })).status, 503);
  } finally {
    await worker.dispose();
  }
});

test('el diagnóstico separa sesiones, protege el registro y muestra el circuito de impresión', async () => {
  const { worker, call } = fixture();
  try {
    const guestSession = await call('logs/session');
    assert.deepEqual(await guestSession.json(), { authenticated: false, configured: true });
    assert.equal((await call('logs')).status, 401);
    assert.equal((await call('logs', { headers: printer })).status, 401);
    const access = { username: 'LaGlotona', password: pass };
    assert.equal((await call('logs/login', { body: access, headers: { ...browser, Origin: 'https://otra-web.invalid' } })).status, 403);
    assert.equal((await call('logs/login', { body: { ...access, username: 'laglotona' }, headers: browser })).status, 401);
    const ownerLogin = await call('login', { body: { code: ownerCode }, headers: browser });
    const owner = { ...browser, Cookie: ownerLogin.headers.get('set-cookie').split(';')[0] };
    assert.equal((await call('logs', { headers: owner })).status, 401);
    assert.equal((await call('impresora/telemetria', { body: { state: 'ready' }, headers: owner })).status, 401);

    const login = await call('logs/login', { body: access, headers: browser });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^__Host-punto-cero-logs=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$/);
    const admin = { ...browser, Cookie: setCookie.split(';')[0] };
    assert.equal((await (await call('logs/session', { headers: admin })).json()).authenticated, true);
    assert.equal((await call('comandas', { headers: admin })).status, 401);
    assert.equal((await call('logs?level=mal', { headers: admin })).status, 400);

    const read = async (query = '') => {
      const response = await call('logs' + query, { headers: admin });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    assert.deepEqual((await read()).health.bridge, { status: 'unknown', lastSeenAt: null });
    const signal = body => call('impresora/telemetria', { body, headers: printer });
    assert.equal((await signal({ state: 'ready', event: 'texto no autorizado' })).status, 400);
    assert.equal((await signal({ state: 'ready' })).status, 200);
    assert.equal((await signal({ state: 'ready' })).status, 200);
    assert.equal((await read()).health.bridge.status, 'online');
    assert.equal((await signal({ state: 'unavailable', event: 'bridge_claim_unreachable' })).status, 200);
    assert.equal((await read()).health.bridge.status, 'unavailable');
    const bridgeEvents = (await read('?source=printer')).events;
    assert.equal(bridgeEvents.filter(event => event.code === 'bridge_online').length, 1);
    assert.ok(bridgeEvents.some(event => event.code === 'bridge_printer_unavailable'));
    assert.ok(bridgeEvents.some(event => event.code === 'bridge_claim_unreachable'));

    const catalog = await (await call('menu')).json();
    const item = catalog.menu.items.find(product => product.name === 'Gildas de queso y cecina');
    const request = {
      id: randomUUID(),
      service: 'delivery',
      menuRevision: catalog.revision,
      delivery: { zone: 'la-barca', address: 'Calle Datos Ficticios 27', phone: '+34 600 000 111', payment: 'card' },
      note: 'Nota ficticia y privada',
      lines: [{ itemId: item.id, priceIndex: 0, quantity: 1, expectedCents: 200 }],
    };
    const create = await call('comandas', { body: request, headers: owner });
    assert.equal(create.status, 201);
    const { order } = await create.json();
    assert.equal((await call('comandas', { body: request, headers: owner })).status, 200);
    const queued = await read();
    assert.equal(queued.health.queue.pending, 1);
    assert.ok(queued.health.queue.oldestPendingAt);
    assert.equal(queued.events.filter(event => event.code === 'order_queued').length, 1);
    const claim = await call('impresora/claim', { body: {}, headers: printer });
    const { job } = await claim.json();
    assert.equal(job.id, order.id);
    assert.equal((await read()).health.queue.printing, 1);
    const body = { id: job.id, claimToken: job.claimToken, status: 'failed', error: 'Texto privado de prueba' };
    for (let retry = 0; retry < 2; retry++) assert.equal((await call('impresora/result', { body, headers: printer })).status, 200);
    const failed = await read('?level=error&source=printer');
    assert.equal(failed.health.queue.printing, 0);
    assert.deepEqual(failed.events.map(event => [event.code, event.orderNumber]), [['print_failed', order.number]]);
    const all = JSON.stringify(await read());
    for (const sensitive of [request.delivery.address, request.delivery.phone, request.note, item.name, job.claimToken, body.error, pass, printerToken]) {
      assert.equal(all.includes(sensitive), false);
    }

    const db = await worker.getD1Database('DB');
    const copy = await call('comandas/reimprimir', { body: { id: order.id, attempt: 1 }, headers: owner });
    assert.equal(copy.status, 200);
    const { job: copyJob } = await (await call('impresora/claim', { body: {}, headers: printer })).json();
    await db.prepare('UPDATE print_attempts SET lease_until=0 WHERE claim_token=?').bind(copyJob.claimToken).run();
    const expired = await read('?level=warn&source=printer');
    assert.equal(expired.health.queue.printing, 0);
    assert.ok(expired.events.some(event => event.code === 'print_lease_expired' && event.orderNumber === order.number));
    assert.equal((await read()).events.filter(event => event.code === 'print_lease_expired').length, 1);

    await db.prepare('UPDATE diagnostic_bridge SET last_seen_at=0').run();
    assert.equal((await read()).health.bridge.status, 'offline');
    const auth = (await read('?source=auth')).events;
    assert.ok(auth.some(event => event.code === 'logs_login_failed'));
    assert.ok(auth.some(event => event.code === 'logs_login_success'));
    assert.equal((await call('logs/logout', { body: {}, headers: admin })).status, 200);
    assert.equal((await call('logs', { headers: admin })).status, 401);
    assert.equal((await call('comandas', { headers: owner })).status, 200);

    for (let attempt = 0; attempt < 5; attempt++) {
      const rejected = await call('logs/login', { body: { ...access, password: 'incorrecta' }, headers: browser });
      assert.equal(rejected.status, 401);
    }
    assert.equal((await call('logs/login', { body: access, headers: browser })).status, 429);
  } finally {
    await worker.dispose();
  }
});
