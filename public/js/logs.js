const byId = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Madrid',
});
const numberFormat = new Intl.NumberFormat('es-ES');
const levelNames = { error: 'Error', warn: 'Aviso', info: 'Información' };
const sourceNames = { web: 'Web', printer: 'Impresión', auth: 'Acceso' };
const bridgeNames = {
  online: 'Conectado', offline: 'Sin contacto reciente', unavailable: 'Impresora no disponible', unknown: 'Sin contacto registrado',
};
const eventNames = {
  order_queued: 'Comanda en cola',
  order_reprint_queued: 'Copia en cola',
  order_claimed: 'El puente recogió el trabajo',
  print_sent: 'Ticket enviado a la cola de Windows',
  print_failed: 'Fallo al enviar el ticket a Windows',
  print_uncertain: 'Envío a Windows sin confirmar',
  print_lease_expired: 'Venció el plazo de confirmación del ticket',
  worker_error: 'El servidor no pudo completar una solicitud',
  bridge_online: 'El puente de Windows se conectó',
  bridge_printer_unavailable: 'El puente no pudo acceder a la cola de Windows',
  bridge_printer_ready: 'La cola de Windows vuelve a estar disponible',
  bridge_claim_unreachable: 'El puente no pudo consultar la cola de comandas',
  bridge_result_unreachable: 'El puente no pudo comunicar el resultado',
  bridge_ack_conflict: 'La web rechazó la confirmación del puente',
  logs_login_failed: 'Intento de acceso incorrecto',
  logs_login_success: 'Se inició sesión en diagnóstico',
  logs_login_rate_limited: 'Acceso limitado por demasiados intentos',
};

const workspace = byId('diagnostics-workspace');
const signIn = byId('diagnostics-sign-in');
const signOut = byId('diagnostics-logout');
const retryAccess = byId('diagnostics-retry-access');
const refresh = byId('diagnostics-refresh');
const eventList = byId('diagnostics-events');
const levelFilter = byId('logs-level');
const sourceFilter = byId('logs-source');
let checkingAccess = false;
let signingOut = false;
let authenticated = false;
let request = null;
let eventsSignature = null;

function updateText(id, text = '') {
  const element = byId(id);
  if (element.textContent !== text) element.textContent = text;
}

function feedback(id, text = '', error = false) {
  updateText(id, text);
  byId(id).classList.toggle('error', error);
}

async function api(path, body) {
  const headers = { Accept: 'application/json' };
  const options = { headers, cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-Punto-Cero'] = 'editar';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`/api/logs${path}`, options);
  if (!response.ok) throw Object.assign(new Error('Solicitud rechazada'), { status: response.status });
  return response.json();
}

function formattedDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '';
}

function setSession(active, configured, { retry = false, message = '', error = false } = {}) {
  authenticated = active;
  workspace.hidden = !active;
  signOut.hidden = !active;
  retryAccess.hidden = !retry;
  byId('diagnostics-login').hidden = active || !configured;
  feedback('diagnostics-access-feedback', message, error);
  if (!active) {
    request = null;
    refresh.disabled = false;
    eventsSignature = null;
    eventList.replaceChildren();
    renderHealth();
    updateText('diagnostics-empty');
    feedback('diagnostics-feedback');
    updateText('diagnostics-last-update', 'Esperando la primera lectura.');
  }
}

async function checkAccess() {
  if (checkingAccess) return;
  checkingAccess = true;
  retryAccess.disabled = true;
  feedback('diagnostics-access-feedback', 'Comprobando el acceso…');
  try {
    const { configured, authenticated: active } = await api('/session');
    setSession(configured === true && active === true, configured === true, configured === true ? {} : {
      retry: true, message: 'El acceso a diagnóstico requiere configuración en el servidor.', error: true,
    });
    if (authenticated) void loadSnapshot();
  } catch {
    setSession(false, false, { retry: true, message: 'No se ha podido comprobar el acceso a diagnóstico.', error: true });
  } finally {
    checkingAccess = false;
    retryAccess.disabled = false;
  }
}

function renderHealth(health) {
  const bridge = health?.bridge;
  const queue = health?.queue;
  const bridgeStatus = byId('bridge-status');
  bridgeStatus.dataset.state = bridge?.status ?? '';
  const lastSeen = formattedDate(bridge?.lastSeenAt);
  const oldestPending = formattedDate(queue?.oldestPendingAt);
  updateText('bridge-status', bridge ? bridgeNames[bridge.status] ?? 'Estado desconocido' : '—');
  updateText('bridge-detail', lastSeen ? `Último contacto · ${lastSeen}` : '');
  updateText('queue-pending', Number.isInteger(queue?.pending) ? numberFormat.format(queue.pending) : '—');
  updateText('queue-printing', Number.isInteger(queue?.printing) ? numberFormat.format(queue.printing) : '—');
  updateText('queue-detail', oldestPending ? `En espera desde · ${oldestPending}` : '');
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderEvents(events) {
  const signature = JSON.stringify(events);
  if (signature === eventsSignature) return;
  eventsSignature = signature;
  const rows = events.map(event => {
    const row = textElement('li', '', 'diagnostics-event');
    const at = formattedDate(event.at);
    const time = textElement('time', at || 'Hora sin registrar');
    if (at) time.dateTime = event.at;
    const meta = textElement('div', '', 'diagnostics-event-meta');
    const level = textElement('strong', levelNames[event.level] ?? 'Evento', 'diagnostics-level');
    level.dataset.level = event.level;
    const source = textElement('span', sourceNames[event.source] ?? 'Origen desconocido');
    const description = textElement('div', eventNames[event.code] ?? 'Actividad de diagnóstico');
    if (Number.isInteger(event.orderNumber) && event.orderNumber > 0) {
      description.append(textElement('small', `Comanda #${event.orderNumber}`, 'order-reference'));
    }
    meta.append(level, source);
    row.append(time, meta, description);
    return row;
  });
  eventList.replaceChildren(...rows);
  updateText('diagnostics-empty', rows.length ? '' : 'No hay eventos para los filtros elegidos.');
}

async function loadSnapshot() {
  if (!authenticated || signingOut) return;
  const params = new URLSearchParams();
  if (levelFilter.value) params.set('level', levelFilter.value);
  if (sourceFilter.value) params.set('source', sourceFilter.value);
  const query = params.size ? `?${params}` : '';
  if (request?.query === query) return;
  const current = { query };
  request = current;
  refresh.disabled = true;
  if (eventsSignature === null) feedback('diagnostics-feedback', 'Cargando diagnóstico…');
  try {
    const { events, health } = await api(query);
    if (request !== current || !authenticated) return;
    renderHealth(health);
    renderEvents(events);
    updateText('diagnostics-last-update', `Última lectura · ${dateFormat.format(new Date())} (hora peninsular)`);
    feedback('diagnostics-feedback');
  } catch (error) {
    if (request !== current || !authenticated) return;
    if (error.status === 401 || error.status === 403) {
      setSession(false, true, { message: 'Vuelve a iniciar sesión en diagnóstico.', error: true });
      byId('diagnostics-username').focus();
    } else {
      feedback('diagnostics-feedback', 'No se ha podido actualizar el diagnóstico. Pulsa «Actualizar» para reintentar.', true);
    }
  } finally {
    if (request === current) {
      request = null;
      refresh.disabled = false;
    }
  }
}

byId('diagnostics-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (signIn.disabled) return;
  signIn.disabled = true;
  const field = byId('diagnostics-password');
  feedback('diagnostics-access-feedback', 'Comprobando el acceso…');
  try {
    const result = api('/login', { username: byId('diagnostics-username').value.trim(), password: field.value });
    field.value = '';
    await result;
    await checkAccess();
    if (authenticated) levelFilter.focus();
  } catch (error) {
    const invalid = [400, 401, 403].includes(error.status);
    const message = error.status === 429 ? 'Demasiados intentos. Espera antes de volver a intentarlo.' :
      invalid ? 'El usuario o la contraseña no son correctos.' : 'No se ha podido iniciar sesión. Vuelve a intentarlo.';
    feedback('diagnostics-access-feedback', message, true);
    field.focus();
  } finally {
    signIn.disabled = false;
  }
});

signOut.addEventListener('click', async () => {
  if (signingOut) return;
  signingOut = true;
  signOut.disabled = true;
  try {
    await api('/logout', {});
    setSession(false, true);
    byId('diagnostics-username').value = '';
    byId('diagnostics-username').focus();
  } catch {
    feedback('diagnostics-access-feedback', 'No se ha podido cerrar la sesión. Vuelve a intentarlo.', true);
  } finally {
    signingOut = false;
    signOut.disabled = false;
  }
});

function changeFilter() {
  eventsSignature = null;
  eventList.replaceChildren();
  updateText('diagnostics-empty');
  void loadSnapshot();
}

function refreshVisible() { if (!document.hidden) void loadSnapshot(); }

retryAccess.addEventListener('click', () => void checkAccess());
refresh.addEventListener('click', () => void loadSnapshot());
levelFilter.addEventListener('change', changeFilter);
sourceFilter.addEventListener('change', changeFilter);
document.addEventListener('visibilitychange', refreshVisible);
setInterval(refreshVisible, 18000);
void checkAccess();
