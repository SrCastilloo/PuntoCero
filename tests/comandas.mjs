import { Miniflare } from 'miniflare';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SITE = 'https://punto-cero-comandas-test.pages.dev';
const CODE = 'LOCAL-TEST-ONLY';
const PRINTER_TOKEN = 'a'.repeat(64);
const BROWSER = { Origin: SITE, 'X-Punto-Cero': 'editar' };
const PRINTER = { Authorization: 'Bearer ' + PRINTER_TOKEN };

function fixture(database) {
  const worker = new Miniflare({
    modules: true,
    scriptPath: 'dist/_worker.js',
    compatibilityDate: '2026-05-01',
    cf: false,
    d1Databases: { DB: database },
    bindings: {
      ADMIN_CODE_HASH: createHash('sha256').update(CODE).digest('hex'),
      PRINT_AGENT_TOKEN: PRINTER_TOKEN,
    },
  });
  const call = (path, { body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) =>
    worker.dispatchFetch(SITE + '/api/' + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { worker, call };
}

test('las comandas privadas se guardan una vez y se imprimen mediante concesiones exclusivas', async () => {
  const { worker, call } = fixture('test-orders');
  try {
    assert.equal((await call('comandas')).status, 401);
    assert.equal((await call('comandas', { body: {}, headers: BROWSER })).status, 401);
    assert.equal((await call('impresora/claim', { body: {} })).status, 401);
    assert.equal((await call('comandas', { headers: PRINTER })).status, 401);
    const login = await call('login', { body: { code: CODE }, headers: BROWSER });
    assert.equal(login.status, 200);
    const owner = { ...BROWSER, Cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.equal((await call('impresora/claim', { body: {}, headers: owner })).status, 401);
    assert.equal((await call('comandas', { body: {}, headers: { ...owner, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await call('comandas', { body: {}, headers: owner })).status, 400);

    const catalog = await (await call('menu')).json();
    const product = catalog.menu.items.find(item => item.name === 'Gildas de queso y cecina');
    const draft = {
      id: randomUUID(),
      table: 'Mesa 6',
      menuRevision: catalog.revision,
      note: 'Servir juntos',
      lines: [{ itemId: product.id, priceIndex: 1, quantity: 2, note: 'Sin aceite', expectedCents: 700, expectedVariant: '5 unidades' }],
    };
    const send = body => call('comandas', { body, headers: owner });
    const reprint = body => call('comandas/reimprimir', { body, headers: owner });
    const claim = async () => {
      const response = await call('impresora/claim', { body: {}, headers: PRINTER });
      assert.equal(response.status, 200);
      return (await response.json()).job;
    };
    const finish = (job, status, error) => call('impresora/result', {
      body: { id: job.id, claimToken: job.claimToken, status, error },
      headers: PRINTER,
    });
    const history = async () => {
      const response = await call('comandas', { headers: owner });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await response.json()).orders;
    };

    const priceChanged = structuredClone(draft);
    priceChanged.lines[0].expectedCents--;
    assert.equal((await send(priceChanged)).status, 409);
    const variantChanged = structuredClone(draft);
    variantChanged.lines[0].expectedVariant = '1 unidad';
    assert.equal((await send(variantChanged)).status, 409);
    const stale = { ...draft, menuRevision: 100 };
    assert.equal((await send(stale)).status, 409);
    assert.deepEqual(await history(), []);

    const duplicated = await Promise.all([send(draft), send(draft)]);
    assert.deepEqual(duplicated.map(result => result.status).sort(), [200, 201]);
    const [first, repeat] = await Promise.all(duplicated.map(async response => (await response.json()).order));
    assert.deepEqual(first, repeat);
    assert.deepEqual(first.lines, [{
      name: product.name, variant: '5 unidades', quantity: 2, note: 'Sin aceite', unitCents: 700,
    }]);
    assert.equal(first.totalCents, 1400);
    assert.equal(first.status, 'pending');
    assert.equal(first.attempt, 1);
    assert.equal((await send({ ...draft, table: 'Mesa 7' })).status, 409);
    assert.equal((await reprint({ id: first.id, attempt: 1 })).status, 409);
    const secondResponse = await send({ ...draft, id: randomUUID(), table: 'Barra' });
    assert.equal(secondResponse.status, 201);
    const second = (await secondResponse.json()).order;

    const claims = await Promise.all([claim(), claim()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const firstJob = claims.find(Boolean);
    assert.equal(firstJob.id, first.id);
    assert.equal(firstJob.isCopy, false);
    assert.equal((await reprint({ id: first.id, attempt: 1 })).status, 409);
    assert.equal((await finish({ ...firstJob, id: second.id }, 'sent')).status, 409);
    assert.equal((await finish(firstJob, 'sent')).status, 200);
    assert.equal((await finish(firstJob, 'sent')).status, 200);
    assert.equal((await finish(firstJob, 'failed')).status, 409);

    const secondJob = await claim();
    assert.equal(secondJob.id, second.id);
    const db = await worker.getD1Database('DB');
    await db.prepare('UPDATE print_attempts SET lease_until=0 WHERE claim_token=?').bind(secondJob.claimToken).run();
    assert.equal(await claim(), null);
    assert.deepEqual((await history()).map(({ id, status }) => [id, status]), [[second.id, 'uncertain'], [first.id, 'sent']]);

    const reprints = await Promise.all([reprint({ id: second.id, attempt: 1 }), reprint({ id: second.id, attempt: 1 })]);
    assert.deepEqual(reprints.map(result => result.status).sort(), [200, 409]);
    const copy = await claim();
    assert.equal(copy.id, second.id);
    assert.equal(copy.isCopy, true);
    assert.equal(copy.attempt, 2);
    assert.equal(copy.number, secondJob.number);
    assert.notEqual(copy.claimToken, secondJob.claimToken);
    assert.equal((await finish(secondJob, 'sent')).status, 200);
    assert.equal((await history())[0].status, 'printing');
    assert.equal((await finish(copy, 'failed', 'Cola no disponible')).status, 200);
    assert.equal((await finish(copy, 'failed', 'Cola no disponible')).status, 200);
    assert.equal((await finish(copy, 'sent')).status, 409);
    assert.equal(await claim(), null);
    const [failed] = await history();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.printError, 'Cola no disponible');
    assert.equal('claimToken' in failed, false);
    assert.equal((await reprint({ id: first.id, attempt: 1 })).status, 200);

    const privateMenu = await (await call('edit', { headers: owner })).json();
    const privateProduct = privateMenu.menu.items.find(item => item.id === product.id);
    privateProduct.prices[1].cents = 750;
    const changed = await call('menu', { method: 'PUT', body: privateMenu, headers: owner });
    assert.equal(changed.status, 200);
    const original = await send(draft);
    assert.equal(original.status, 200);
    assert.equal((await original.json()).order.totalCents, 1400);
    assert.equal((await send({ ...draft, id: randomUUID(), menuRevision: undefined })).status, 409);
    const lost = await call('logout', { body: {}, headers: owner });
    assert.equal(lost.status, 200);
    assert.equal((await call('comandas', { headers: owner })).status, 401);
  } finally {
    await worker.dispose();
  }
});

test('mesas, recogida y domicilio mantienen cuentas y cobros coherentes', async () => {
  const { worker, call } = fixture('test-services');
  try {
    assert.equal((await call('comandas/mesas')).status, 401);
    assert.equal((await call('comandas/cuenta?table=14', { headers: PRINTER })).status, 401);
    assert.equal((await call('comandas/cobrar', { body: {}, headers: BROWSER })).status, 401);
    const login = await call('login', { body: { code: CODE }, headers: BROWSER });
    assert.equal(login.status, 200);
    const headers = { ...BROWSER, Cookie: login.headers.get('set-cookie').split(';')[0] };
    const get = async path => {
      const response = await call(path, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    const post = (path, body) => call(path, { body, headers });
    const accountFor = async number => (await get(`comandas/cuenta?table=${number}`)).account;
    const send = body => post('comandas', body);
    const charge = body => post('comandas/cobrar', body);
    const catalog = await get('menu');
    const product = catalog.menu.items.find(item => item.name === 'Gildas de queso y cecina');
    const draft = {
      menuRevision: catalog.revision,
      note: 'Servir juntas',
      lines: [{ itemId: product.id, priceIndex: 1, quantity: 2, note: '', expectedCents: 700, expectedVariant: '5 unidades' }],
    };

    const initial = await get('comandas/mesas');
    assert.equal(initial.tableCount, 14);
    assert.deepEqual(initial.tables.map(table => table.number), Array.from({ length: 14 }, (_, i) => i + 1));
    assert.ok(initial.tables.every(table => table.account === null));
    assert.equal(await accountFor(14), null);
    assert.equal((await call('comandas/mesas', { body: { count: 15 }, headers: { ...headers, Origin: 'https://otra-web.example' } })).status, 403);
    assert.equal((await post('comandas/mesas', { count: 16 })).status, 200);
    assert.equal((await get('comandas/mesas')).tableCount, 16);

    const round = { ...draft, id: randomUUID(), service: 'table', tableNumber: 14, expectedAccountId: null };
    const simultaneous = await Promise.all([send(round), send({ ...round, id: randomUUID() })]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [201, 409]);
    const first = (await simultaneous.find(response => response.status === 201).json()).order;
    const current = await accountFor(14);
    assert.equal(first.service, 'table');
    assert.equal(first.tableNumber, 14);
    assert.equal(first.accountNumber, current.number);
    assert.equal(current.totalCents, 1400);
    assert.equal(current.remainingCents, 1400);
    assert.equal((await get('comandas/mesas')).tables[13].account.id, current.id);
    assert.equal((await post('comandas/mesas', { count: 13 })).status, 409);

    const nextRound = { ...round, id: randomUUID(), expectedAccountId: current.id };
    const [placed, repeated] = await Promise.all([send(nextRound), send(nextRound)]);
    assert.deepEqual([placed.status, repeated.status].sort(), [200, 201]);
    const second = (await placed.json()).order;
    assert.notEqual(second.number, first.number);
    assert.equal(second.accountNumber, first.accountNumber);
    const beforePayment = await accountFor(14);
    assert.equal(beforePayment.totalCents, 2800);
    assert.equal(beforePayment.orders.length, 2);
    assert.equal(beforePayment.payments.length, 0);

    const part = { id: randomUUID(), accountId: current.id, version: beforePayment.version, cents: 933, method: 'cash' };
    assert.equal((await call('comandas/cobrar', { body: part, headers: { ...headers, Origin: 'https://otra-web.example' } })).status, 403);
    const rivalPart = { ...part, id: randomUUID() };
    const conflict = await Promise.all([charge(part), charge(rivalPart)]);
    assert.deepEqual(conflict.map(response => response.status).sort(), [200, 409]);
    const successfulPart = conflict[0].status === 200 ? part : rivalPart;
    const afterPayment = await accountFor(14);
    assert.equal(afterPayment.paidCents, 933);
    assert.equal(afterPayment.remainingCents, 1867);
    assert.equal(afterPayment.payments.length, 1);
    assert.equal((await charge(successfulPart)).status, 200);
    const partTwo = { ...part, id: randomUUID(), version: afterPayment.version, method: 'card' };
    const secondPayment = await charge(partTwo);
    assert.equal(secondPayment.status, 200);
    const { account: afterTwo } = await secondPayment.json();
    assert.equal(afterTwo.remainingCents, 934);
    const finalPart = { ...part, id: randomUUID(), version: afterTwo.version, cents: 934 };
    assert.equal((await charge(finalPart)).status, 200);
    assert.equal((await charge(finalPart)).status, 200);
    assert.equal((await charge({ ...finalPart, cents: 933 })).status, 409);
    assert.equal(await accountFor(14), null);
    assert.equal((await get('comandas/mesas')).tables[13].account, null);
    assert.equal((await send({ ...nextRound, id: randomUUID() })).status, 409);

    const pickup = await send({ ...draft, id: randomUUID(), service: 'pickup', reference: 'Recogida de prueba' });
    assert.equal(pickup.status, 201);
    const { order: takeaway } = await pickup.json();
    assert.equal(takeaway.service, 'pickup');
    assert.equal(takeaway.reference, 'Recogida de prueba');
    assert.equal(takeaway.totalCents, 1400);
    assert.equal(takeaway.deliveryFeeCents, 0);
    assert.notEqual(takeaway.accountNumber, first.accountNumber);

    const destination = { zone: 'la-barca', address: 'Calle de Prueba 7', phone: '+34 600 000 001', payment: 'exact' };
    const delivery = { ...draft, id: randomUUID(), service: 'delivery', delivery: destination };
    assert.equal((await send({ ...delivery, delivery: { ...destination, phone: 'sin número' } })).status, 400);
    const barcaResponse = await send(delivery);
    assert.equal(barcaResponse.status, 201);
    const { order: barca } = await barcaResponse.json();
    assert.equal(barca.deliveryFeeCents, 200);
    assert.equal(barca.subtotalCents, 1400);
    assert.equal(barca.totalCents, 1600);
    assert.deepEqual(barca.delivery, destination);
    const mcDelivery = { ...delivery, id: randomUUID(), delivery: { ...destination, zone: 'mc', payment: 'change', cashCents: 2000 } };
    const tooLittle = await send({ ...mcDelivery, delivery: { ...mcDelivery.delivery, cashCents: 1600 } });
    assert.equal(tooLittle.status, 400);
    const mcResponse = await send(mcDelivery);
    assert.equal(mcResponse.status, 201);
    const { order: mc } = await mcResponse.json();
    assert.equal(mc.totalCents, 1700);
    assert.equal(mc.delivery.cashCents, 2000);
    const cardResponse = await send({ ...delivery, id: randomUUID(), delivery: { ...destination, payment: 'card' } });
    assert.equal(cardResponse.status, 201);
    const { order: card } = await cardResponse.json();
    assert.equal(card.delivery.payment, 'card');
    assert.equal((await call('comandas', { headers: PRINTER })).status, 401);

    const newService = await send({ ...round, id: randomUUID(), tableNumber: 14, expectedAccountId: null });
    assert.equal(newService.status, 201);
    const { order: reopened } = await newService.json();
    assert.notEqual(reopened.accountNumber, first.accountNumber);
    const reopenedAccount = await accountFor(14);
    assert.equal(reopenedAccount.remainingCents, 1400);
    assert.equal((await charge({ ...part, id: randomUUID(), accountId: reopenedAccount.id, version: reopenedAccount.version, cents: 1400 })).status, 200);

    for (const expected of [first, second, takeaway, barca, mc, card, reopened]) {
      const claim = await call('impresora/claim', { body: {}, headers: PRINTER });
      assert.equal(claim.status, 200);
      const { job } = await claim.json();
      assert.equal(job.id, expected.id);
      assert.equal(job.accountNumber, expected.accountNumber);
      assert.deepEqual(job.delivery, expected.delivery);
      assert.equal((await call('impresora/result', {
        body: { id: job.id, claimToken: job.claimToken, status: 'sent' }, headers: PRINTER,
      })).status, 200);
    }
    assert.equal((await post('comandas/mesas', { count: 13 })).status, 200);
    assert.equal((await get('comandas/mesas')).tableCount, 13);
  } finally {
    await worker.dispose();
  }
});
