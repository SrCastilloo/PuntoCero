import { validateMenu, publicMenu } from './menu';
import { accountDetails, authenticatePrinter, claimPrintJob, createOrder, expirePrintLease, finishPrintJob, listOrders, orderSchema, reprintOrder } from './comandas';
import { listTables, recordTablePayment, setTableCount, tableAccountLookup } from './comandas-servicio';
import { bridgeTelemetry, diagnosticLogin, diagnosticLogout, diagnosticSession, readDiagnostics, recordDiagnostic } from './diagnostico';
import seed from './seed.json';
import qrcode from 'qrcode-generator';

const PHOTO = /^[a-f0-9-]{36}\.(jpg|png|webp)$/;
const SESSION = '__Host-punto-cero';
const MAX_PHOTO = 950_000;
const orderMethods = new Map([
  ['/api/comandas', ['GET', 'POST']],
  ['/api/comandas/reimprimir', ['POST']],
  ['/api/comandas/mesas', ['GET', 'POST']],
  ['/api/comandas/cuenta', ['GET']],
  ['/api/comandas/cobrar', ['POST']],
]);
const diagnosticMethods = new Map([
  ['/api/logs', 'GET'],
  ['/api/logs/session', 'GET'],
  ['/api/logs/login', 'POST'],
  ['/api/logs/logout', 'POST'],
]);
const printerPaths = new Set(['/api/impresora/claim', '/api/impresora/result', '/api/impresora/telemetria']);
const menuPaths = new Set(['/api/menu', '/api/status', '/api/edit', '/api/photos', '/qr/carta-qr.svg']);
const ownerLoginPaths = new Set(['/api/login', '/api/logout']);
const schema = [
  'CREATE TABLE IF NOT EXISTS menu_document (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS login_attempts (id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
  ...orderSchema,
];
let schemaReady: Promise<void> | null = null;
const base = validateMenu(seed);

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function json(body: unknown, status = 200, extra = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function token() { return [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join(''); }
function cookie(request: Request) { return request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-punto-cero=([a-f0-9]{64})(?:;|$)/)?.[1]; }
function cookieHeader(value: string, seconds: number) { return `${SESSION}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`; }
function configured(env: any) { return !!env.DB && /^[a-f0-9]{64}$/.test(env.ADMIN_CODE_HASH || ''); }
function guard(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('x-punto-cero') !== 'editar') fail('Petición no permitida.', 403);
}
async function bodyBytes(request: Request, limit: number) {
  if (Number(request.headers.get('content-length') || 0) > limit) fail('El archivo es demasiado grande.', 413);
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); fail('El archivo es demasiado grande.', 413); } chunks.push(value); }
  const out = new Uint8Array(size); let pos = 0; for (const chunk of chunks) { out.set(chunk, pos); pos += chunk.length; } return out;
}
async function readJson(request: Request, limit = 1_500_000) {
  const bytes = await bodyBytes(request, limit); try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('No se ha podido leer el contenido.'); }
}
function noTable(e: any) { return /no such table/i.test(String(e.message)); }
async function prepare(env: any) {
  if (!schemaReady) schemaReady = env.DB.batch(schema.map(sql => env.DB.prepare(sql))).then(() => {}).catch((e: any) => { schemaReady = null; throw e; });
  await schemaReady;
}
async function isOwner(request: Request, env: any) {
  const value = cookie(request); if (!value || !configured(env)) return false;
  try { return !!await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').bind(await digest(value), Date.now()).first(); } catch (e) { if (noTable(e)) return false; throw e; }
}
async function mustOwn(request: Request, env: any) { if (!await isOwner(request, env)) fail('Introduce tu código para editar la carta.', 401); }
async function load(env: any) {
  let row: any = null;
  if (env.DB) try { row = await env.DB.prepare('SELECT payload,revision,updated_at FROM menu_document WHERE id=1').first(); } catch (e) { if (!noTable(e)) throw e; }
  return row ? { menu: validateMenu(JSON.parse(row.payload)), revision: row.revision, updatedAt: row.updated_at } : { menu: base, revision: 0, updatedAt: null };
}
function imageResponse(bytes: ArrayBuffer | Uint8Array, type: string) {
  return new Response(bytes as BodyInit, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" } });
}
async function photo(request: Request, env: any, key: string) {
  if (!PHOTO.test(key)) return json({ error: 'Imagen no encontrada.' }, 404);
  let row: any = null;
  if (env.DB) try { row = await env.DB.prepare('SELECT content_type,bytes FROM photos WHERE id=?').bind(key).first(); } catch (e) { if (!noTable(e)) throw e; }
  if (row) return imageResponse(new Uint8Array(row.bytes), row.content_type);
  const url = new URL(request.url); url.pathname = '/img/migradas/' + key; url.search = '';
  const res = await env.ASSETS.fetch(new Request(url, request));
  return res.ok && /^image\/(jpeg|png|webp)/.test(res.headers.get('content-type') || '') ? imageResponse(await res.arrayBuffer(), res.headers.get('content-type')!) : json({ error: 'Imagen no encontrada.' }, 404);
}
async function route(request: Request, env: any) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/qr/carta-qr.svg') {
    const qr = qrcode(0, 'M'); qr.addData(url.origin + '/'); qr.make();
    return new Response(qr.createSvgTag({ cellSize: 8, margin: 32, scalable: true }), { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (!path.startsWith('/api/')) {
    if (path === '/' || path === '/admin') { url.pathname = path === '/' ? '/carta.html' : '/admin.html'; return env.ASSETS.fetch(new Request(url, request)); }
    if (path === '/_worker.js' || path.startsWith('/src/') || path.includes('/.')) return new Response('No encontrado', { status: 404 });
    return env.ASSETS.fetch(request);
  }
  const diagnosticMethod = diagnosticMethods.get(path);
  if (diagnosticMethod) {
    if (request.method !== diagnosticMethod) return json({ error: 'Método no permitido.' }, 405, { Allow: diagnosticMethod });
    if (request.method === 'POST') guard(request);
    const secret = env.LOG_ADMIN_PASSWORD_HASH;
    if (path === '/api/logs/session') return json(await diagnosticSession(request, env.DB, secret));
    if (path === '/api/logs/login') {
      const setCookie = await diagnosticLogin(request, env.DB, secret, await readJson(request, 4096));
      return json({ ok: true }, 200, { 'Set-Cookie': setCookie });
    }
    if (path === '/api/logs/logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': await diagnosticLogout(request, env.DB, secret) });
    }
    const session = await diagnosticSession(request, env.DB, secret);
    if (!session.authenticated) fail('Introduce las credenciales de diagnóstico.', 401);
    await prepare(env);
    await expirePrintLease(env.DB);
    return json(await readDiagnostics(env.DB, url.searchParams));
  }
  if (printerPaths.has(path)) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    await authenticatePrinter(request, env.PRINT_AGENT_TOKEN);
    if (!env.DB) fail('Falta configurar la base de datos de comandas.', 503);
    if (path === '/api/impresora/telemetria') {
      await bridgeTelemetry(env.DB, await readJson(request, 1024));
      return json({ ok: true });
    }
    await prepare(env);
    if (path === '/api/impresora/claim') {
      const job = await claimPrintJob(env.DB, token());
      if (job) await recordDiagnostic(env.DB, 'order_claimed', job.number);
      return json({ job });
    }
    const result = await finishPrintJob(env.DB, await readJson(request, 2048));
    if (result.completed) await recordDiagnostic(env.DB, `print_${result.status}`, result.orderNumber);
    return json({ ok: true });
  }
  const allowed = orderMethods.get(path);
  if (allowed) {
    if (!allowed.includes(request.method)) {
      return json({ error: 'Método no permitido.' }, 405, { Allow: allowed.join(', ') });
    }
    if (request.method === 'POST') guard(request);
    await mustOwn(request, env);
    await prepare(env);
    if (path === '/api/comandas/mesas') {
      return json(request.method === 'GET' ? await listTables(env.DB) : await setTableCount(env.DB, await readJson(request, 1024)));
    }
    if (path === '/api/comandas/cuenta') {
      return json({ account: await accountDetails(env.DB, tableAccountLookup(url.searchParams.get('table'))) });
    }
    if (path === '/api/comandas/cobrar') {
      const lookup = await recordTablePayment(env.DB, await readJson(request, 1024));
      return json({ account: await accountDetails(env.DB, lookup) });
    }
    if (request.method === 'GET') return json({ orders: await listOrders(env.DB) });
    if (path === '/api/comandas/reimprimir') {
      const order = await reprintOrder(env.DB, await readJson(request, 1024));
      await recordDiagnostic(env.DB, 'order_reprint_queued', order.number);
      return json({ order });
    }
    const { order, created } = await createOrder(env.DB, await readJson(request, 65_536), () => load(env));
    if (created) await recordDiagnostic(env.DB, 'order_queued', order.number);
    return json({ order }, created ? 201 : 200);
  }
  if (request.method === 'GET') {
    if (path === '/api/menu') { const value = await load(env); return json({ ...value, menu: publicMenu(value.menu) }); }
    if (path === '/api/status') { const owner = await isOwner(request, env); return json({ owner, signedIn: owner, ready: configured(env), displayName: owner ? 'Propietaria' : '' }); }
    if (path === '/api/edit') { await mustOwn(request, env); return json(await load(env)); }
    if (path.startsWith('/api/photos/')) return photo(request, env, path.slice('/api/photos/'.length));
  }
  if (request.method === 'POST' || request.method === 'PUT') {
    guard(request);
    if (path === '/api/login' && request.method === 'POST') {
      if (!configured(env)) fail('Falta completar la configuración del alojamiento.', 503);
      await prepare(env);
      const input = await readJson(request, 1024), now = Date.now();
      const ip = await digest('login:' + (request.headers.get('cf-connecting-ip') || 'unknown'));
      const attempt: any = await env.DB.prepare('INSERT INTO login_attempts (id,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts,expires_at').bind(ip, now + 900_000, now, now).first();
      if (attempt.attempts > 10) fail('Demasiados intentos. Vuelve a intentarlo dentro de 15 minutos.', 429);
      if (typeof input.code !== 'string' || input.code.length > 200 || await digest(input.code.trim()) !== env.ADMIN_CODE_HASH) fail('El código no es correcto.', 403);
      const value = token(), hash = await digest(value);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
        env.DB.prepare('DELETE FROM login_attempts WHERE expires_at<=? OR id=?').bind(now, ip),
        env.DB.prepare('INSERT INTO sessions (token_hash,expires_at) VALUES (?,?)').bind(hash, now + 7 * 86400_000),
      ]);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(value, 7 * 86400) });
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const value = cookie(request); if (value && env.DB) try { await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(value)).run(); } catch (e) { if (!noTable(e)) throw e; }
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
    }
    await mustOwn(request, env);
    if (path === '/api/menu' && request.method === 'PUT') {
      const input = await readJson(request); if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('La versión no es válida.');
      const menu = validateMenu(input.menu), now = new Date().toISOString(), payload = JSON.stringify(menu);
      if (new TextEncoder().encode(payload).length > 1_500_000) fail('La carta es demasiado grande.', 413);
      const result = input.revision === 0
        ? await env.DB.prepare('INSERT OR IGNORE INTO menu_document (id,payload,revision,updated_at) VALUES (1,?,1,?)').bind(payload, now).run()
        : await env.DB.prepare('UPDATE menu_document SET payload=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?').bind(payload, now, input.revision).run();
      if (result.meta.changes !== 1) fail('La carta cambió desde otra ventana. Descarga una copia de tus cambios y recarga antes de guardar.', 409);
      return json({ ok: true, menu, revision: input.revision + 1, updatedAt: now });
    }
    if (path === '/api/photos' && request.method === 'POST') {
      const bytes = await bodyBytes(request, MAX_PHOTO); if (bytes.length < 12) fail('La imagen no es válida.');
      let type: string, ext: string;
      if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { type = 'image/jpeg'; ext = 'jpg'; }
      else if ([137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) { type = 'image/png'; ext = 'png'; }
      else if (new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') { type = 'image/webp'; ext = 'webp'; }
      else fail('Usa una imagen JPG, PNG o WebP.');
      const key = crypto.randomUUID() + '.' + ext;
      await env.DB.prepare('INSERT INTO photos (id,content_type,bytes,created_at) VALUES (?,?,?,?)').bind(key, type, bytes.buffer, Date.now()).run();
      return json({ key }, 201);
    }
  }
  return json({ error: 'No encontrado.' }, 404);
}
export default {
  async fetch(request: Request, env: any) {
    try { return await route(request, env); }
    catch (error: any) {
      if (error.name === 'ZodError') return json({ error: error.issues?.[0]?.message || 'Revisa los campos.' }, 400);
      if (!error.status) {
        const path = new URL(request.url).pathname;
        if (printerPaths.has(path) || orderMethods.has(path) || diagnosticMethods.has(path)
          || ownerLoginPaths.has(path) || menuPaths.has(path) || /^\/api\/photos\/[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path)) {
          const source = printerPaths.has(path) ? 'printer' : diagnosticMethods.has(path) || ownerLoginPaths.has(path) ? 'auth' : 'web';
          await recordDiagnostic(env.DB, 'worker_error', null, source);
        }
        if (orderMethods.has(path) || printerPaths.has(path) || diagnosticMethods.has(path)) {
          console.error('Fallo en una operación de comandas, impresión o diagnóstico.');
          return json({ error: 'No se ha podido confirmar la operación. Vuelve a intentarlo.' }, 503);
        }
        console.error('Fallo en una operación web.');
      }
      return json({ error: error.status ? error.message : 'No se ha podido conectar. Tus cambios no se han guardado; inténtalo de nuevo.',
        ...(error.status && error.code ? { code: error.code } : {}),
      }, error.status || 503);
    }
  },
};
