import { createBilling, parseCents } from './comandas-cobros.js?v=1';

const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, symbol => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[symbol]);
const euros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const localTime = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid',
});
const money = cents => euros.format(cents / 100);
const searchable = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
const maxLines = 50;
const catalogPageSize = 60;
const storageKey = 'punto-cero:comanda-borrador:v2';
const previousStorageKey = 'punto-cero:comanda-borrador:v1';
const zones = { 'la-barca': ['La Barca', 200], mc: ['MC', 300] };
const deliveryPayments = { change: 'Efectivo con cambio', card: 'Tarjeta', exact: 'Efectivo con importe exacto' };
const states = {
  pending: ['En cola', 'A la espera de que el agente de Windows recoja la comanda.'],
  printing: ['En proceso', 'El agente ha recogido la comanda para enviarla a Windows.'],
  sent: ['Enviada a Windows', 'La cola de Windows aceptó el ticket. Comprueba la salida en papel.'],
  failed: ['Error de impresión', 'El agente avisó de un fallo al enviar el ticket.'],
  uncertain: ['Envío por comprobar', 'No hay confirmación de Windows. Revisa la cola y el papel antes de reimprimir.'],
};

const workspace = byId('workspace');
const draftForm = byId('draft-form');
const closeSession = byId('logout');
const productList = byId('products');
const cartList = byId('draft-lines');
const orderList = byId('orders');
const reprintDialog = byId('reprint-dialog');
const tableGrid = byId('table-grid');
const blankDraft = () => ({
  service: 'table', tableNumber: null, expectedAccountId: null, priorReference: '', reference: '',
  delivery: { zone: '', address: '', phone: '', payment: '', cash: '' },
  note: '', lines: [], submission: null,
});

function restoreDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved && ['table', 'pickup', 'delivery'].includes(saved.service) && saved.delivery && Array.isArray(saved.lines)) {
      return saved;
    }
    const previous = JSON.parse(sessionStorage.getItem(previousStorageKey));
    if (previous && typeof previous.table === 'string' && Array.isArray(previous.lines)) {
      return { ...blankDraft(), priorReference: previous.table, note: previous.note, lines: previous.lines, submission: previous.submission };
    }
  } catch {
    // The panel still works when browser storage is unavailable.
  }
  return blankDraft();
}

let draft = restoreDraft();
let menu = null;
let menuRevision;
let historySignature = null;
let accessVersion = 0;
let showing = catalogPageSize;
let sending = false;
let signingOut = false;
let loadingCatalog = false;
let loadingHistory = false;
let reprinting = null;
let floor = null;
let floorSignature = null;
let viewedTable = draft.tableNumber;
let floorRequest = null;
let savingTables = false;
let floorNeedsRefresh = false;
let floorRevision = 0;
let tableCountEdited = false;
let lastTableOrder = null;
const billing = createBilling({
  api, feedback, escapeHtml, money, localTime, checkExpired,
  onBusy: updateDraftControls,
  onChange: () => void refreshTables({ afterChange: true }),
});

function persistDraft() {
  try {
    if (draft.tableNumber || draft.reference || draft.priorReference || draft.service !== 'table' || draft.note || draft.lines.length || draft.submission) {
      sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } else {
      sessionStorage.removeItem(storageKey);
    }
    sessionStorage.removeItem(previousStorageKey);
  } catch {
    // An unavailable storage area must not prevent sending an order.
  }
}

function feedback(id, message = '', error = false) {
  const element = byId(id);
  if (element.textContent !== message) element.textContent = message;
  element.classList.toggle('error', error);
}

async function api(path, body) {
  const headers = { Accept: 'application/json', 'X-Punto-Cero': 'editar' };
  const options = { cache: 'no-store', credentials: 'same-origin', headers, signal: AbortSignal.timeout(15000) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`/api/${path}`, options);
  } catch {
    throw new Error('No hay respuesta de la web. Comprueba la conexión.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(data?.error || 'La web no ha podido completar la solicitud.'), {
      status: response.status,
      explained: Boolean(data?.error),
      code: data?.code,
    });
  }
  return data;
}

function forgetHistory() {
  historySignature = null;
  orderList.replaceChildren();
  if (reprintDialog.open) reprintDialog.close('cancel');
  feedback('history-action-feedback');
}

function setSession(owner, ready = true) {
  accessVersion++;
  workspace.hidden = !owner;
  closeSession.hidden = !owner;
  byId('login-panel').hidden = owner || !ready;
  byId('retry-access').hidden = ready;
  if (!owner) {
    forgetHistory();
    billing.close();
    floor = null;
    floorSignature = null;
    tableGrid.replaceChildren();
    closeSession.disabled = false;
  }
}

function checkExpired(error) {
  if (error.status !== 401) return false;
  setSession(false);
  feedback('access-feedback', 'Introduce el código de acceso para continuar.', true);
  byId('access-code').focus();
  return true;
}

function tableAt(number) {
  return floor?.tables.find(table => table.number === number);
}

function tableMatchesDraft() {
  const selected = tableAt(draft.tableNumber);
  return Boolean(selected && (selected.account?.id ?? null) === draft.expectedAccountId);
}

function renderTableSelection() {
  const summary = byId('table-selection');
  summary.hidden = draft.service !== 'table';
  if (summary.hidden) return;
  if (!draft.tableNumber) {
    const prior = draft.priorReference ? `Referencia del borrador anterior: ${draft.priorReference}. ` : '';
    feedback('table-selection', `${prior}Selecciona una mesa en el plano.`);
  } else if (floor && !tableMatchesDraft() && !draft.submission) {
    feedback('table-selection', `La Mesa ${draft.tableNumber} ha cambiado. Vuelve a seleccionarla antes de enviar.`, true);
  } else {
    feedback('table-selection', `Mesa ${draft.tableNumber}`);
  }
}

function renderFloor() {
  const signature = JSON.stringify(floor?.tables.map(({ number, account }) => [number, Boolean(account)]));
  if (signature !== floorSignature) {
    const focused = document.activeElement?.dataset.tableNumber;
    floorSignature = signature;
    tableGrid.innerHTML = (floor?.tables ?? []).map(({ number, account }) => {
      const status = account ? 'Ocupada' : 'Libre';
      return `<li><button type="button" data-table-number="${number}" data-occupied="${Boolean(account)}" aria-label="Mesa ${number}, ${status.toLowerCase()}"><strong>Mesa ${number}</strong><span>${status}</span></button></li>`;
    }).join('');
    if (focused) tableGrid.querySelector(`[data-table-number="${focused}"]`)?.focus();
  }
  for (const button of tableGrid.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.tableNumber) === viewedTable));
  }
  const viewed = tableAt(viewedTable);
  const account = viewed?.account;
  if (lastTableOrder && viewedTable === lastTableOrder.tableNumber && account?.number === lastTableOrder.accountNumber) {
    if (draft.service === 'table' && !draft.tableNumber && !draft.submission) {
      draft.tableNumber = viewedTable;
      draft.expectedAccountId = account.id;
      persistDraft();
    }
    lastTableOrder = null;
  }
  const message = account ? `Mesa ${viewed.number} · Cuenta #${account.number} · Pendiente ${money(account.remainingCents)}` :
    viewed ? `Mesa ${viewed.number} libre.` : '';
  feedback('selected-table-account', message);
  byId('open-bill').hidden = !account;
  if (floor && !tableCountEdited) byId('table-count').value = String(floor.tableCount);
  byId('save-table-count').disabled = savingTables || !floor || !tableCountEdited;
  renderTableSelection();
  updateDraftControls();
}

function refreshTables({ afterChange = false } = {}) {
  if (workspace.hidden) return Promise.resolve();
  if (floorRequest) {
    floorNeedsRefresh ||= afterChange;
    return floorRequest;
  }
  const version = accessVersion;
  const revision = floorRevision;
  const refresh = byId('refresh-tables');
  refresh.disabled = true;
  if (!floor) feedback('floor-feedback', 'Cargando mesas…');
  floorRequest = (async () => {
    try {
      const updated = await api('comandas/mesas');
      if (version !== accessVersion || revision !== floorRevision) return;
      floor = updated;
      renderFloor();
      feedback('floor-feedback');
    } catch (error) {
      if (version === accessVersion && !checkExpired(error)) feedback('floor-feedback', error.message, true);
    } finally {
      floorRequest = null;
      refresh.disabled = false;
      const repeat = floorNeedsRefresh || version !== accessVersion;
      floorNeedsRefresh = false;
      if (repeat && !workspace.hidden) void refreshTables();
    }
  })();
  return floorRequest;
}

async function saveTableCount(event) {
  event.preventDefault();
  if (savingTables || !floor || workspace.hidden) return;
  const input = byId('table-count');
  const count = input.valueAsNumber;
  if (count === floor.tableCount) {
    tableCountEdited = false;
    renderFloor();
    return;
  }
  const version = accessVersion;
  savingTables = true;
  input.disabled = true;
  feedback('table-settings-feedback', 'Guardando el plano…');
  renderFloor();
  try {
    const updated = await api('comandas/mesas', { count });
    if (version !== accessVersion) return;
    floorRevision++;
    floor = updated;
    tableCountEdited = false;
    feedback('table-settings-feedback', `Plano actualizado a ${floor.tableCount} ${floor.tableCount === 1 ? 'mesa' : 'mesas'}.`);
  } catch (error) {
    if (version === accessVersion && !checkExpired(error)) feedback('table-settings-feedback', error.message, true);
  } finally {
    savingTables = false;
    input.disabled = false;
    if (!workspace.hidden) renderFloor();
  }
}

async function checkAccess() {
  const retry = byId('retry-access');
  retry.disabled = true;
  feedback('access-feedback', 'Comprobando el acceso…');
  try {
    const { owner, ready } = await api('status');
    setSession(Boolean(owner), Boolean(ready));
    if (!ready) {
      feedback('access-feedback', 'Falta configurar el acceso de propietaria en el alojamiento.', true);
      return;
    }
    feedback('access-feedback');
    if (owner) {
      persistDraft();
      renderDraft();
      billing.renderPendingButton();
      await Promise.all([refreshCatalog(), refreshHistory(), refreshTables()]);
    }
  } catch (error) {
    setSession(false, false);
    feedback('access-feedback', error.message, true);
  } finally {
    retry.disabled = false;
  }
}

function selectedOffer(line) {
  const item = menu?.items.find(candidate => candidate.id === line.itemId);
  const offer = item?.prices[line.priceIndex];
  if (offer && offer.label === line.expectedVariant) return { item, offer, index: line.priceIndex };
  const matches = item?.prices.map((candidate, index) => ({ offer: candidate, index }))
    .filter(candidate => candidate.offer.label === line.expectedVariant) ?? [];
  return matches.length === 1 ? { item, ...matches[0] } : null;
}

function currentLine(line, chosen = selectedOffer(line)) {
  return Boolean(chosen && chosen.index === line.priceIndex && chosen.offer.cents === line.expectedCents && chosen.item.name === line.name);
}

function renderCatalog() {
  const category = byId('category-filter').value;
  const words = searchable(byId('product-search').value).trim().split(/\s+/).filter(Boolean);
  const categories = new Map(menu?.categories.map(option => [option.id, option.name]));
  const matches = (menu?.items ?? []).filter(item => {
    if (!item.prices.length || (category && item.category !== category)) return false;
    const text = searchable([item.name, categories.get(item.category), ...item.prices.map(option => option.label)].join(' '));
    return words.every(word => text.includes(word));
  });
  productList.innerHTML = matches.slice(0, showing).map(item => {
    const options = item.prices.map((option, index) => {
      const label = option.label || (item.prices.length > 1 ? `Opción ${index + 1}` : '');
      const caption = [label, money(option.cents)].filter(Boolean).join(' · ');
      const accessible = `Añadir ${item.name}${label ? `, ${label}` : ''}, ${money(option.cents)}`;
      return `<button type="button" data-product="${escapeHtml(item.id)}" data-option="${index}" aria-label="${escapeHtml(accessible)}">${escapeHtml(caption)}</button>`;
    }).join('');
    return `<li class="catalog-product"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(categories.get(item.category))}</p><div class="product-options">${options}</div></li>`;
  }).join('');
  byId('more-products').hidden = matches.length <= showing;
  if (menu) {
    feedback('catalog-feedback', matches.length ? '' : 'No hay productos que coincidan con la búsqueda.');
  }
  updateDraftControls();
}

async function refreshCatalog({ review = false } = {}) {
  if (loadingCatalog || workspace.hidden) return;
  const version = accessVersion;
  loadingCatalog = true;
  byId('refresh-catalog').disabled = true;
  feedback('catalog-feedback', 'Cargando la carta…');
  try {
    const data = await api('menu');
    if (version !== accessVersion) return;
    const oldCategory = byId('category-filter').value;
    menu = data.menu;
    menuRevision = data.revision;
    byId('category-filter').innerHTML = '<option value="">Todas las carpetas</option>' + menu.categories.map(option =>
      `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
    if (menu.categories.some(option => option.id === oldCategory)) byId('category-filter').value = oldCategory;
    renderCatalog();
    renderDraft();
    if (review) feedback('draft-feedback', 'La carta ha cambiado. Revisa la comanda antes de enviarla.', true);
  } catch (error) {
    if (version === accessVersion) feedback('catalog-feedback', error.message, true);
  } finally {
    loadingCatalog = false;
    byId('refresh-catalog').disabled = false;
    if (version !== accessVersion && !workspace.hidden) void refreshCatalog();
  }
}

function updateDraftControls() {
  const locked = Boolean(draft.submission);
  const stale = menu && draft.lines.some(line => !currentLine(line));
  const readyService = draft.service !== 'table' || tableMatchesDraft();
  const canSubmit = locked || Boolean(menu && draft.lines.length && !stale && readyService);
  byId('draft-fields').disabled = locked || sending;
  byId('pending-submission').hidden = !locked || sending;
  byId('submit-order').disabled = !canSubmit || sending || signingOut;
  byId('submit-order').textContent = sending ? 'Enviando…' : locked ? 'Reintentar envío' : 'Enviar a impresora';
  closeSession.disabled = sending || signingOut || billing.busy;
  byId('open-bill').disabled = signingOut;
  byId('resume-payment').disabled = signingOut;
  productList.querySelectorAll('button').forEach(button => { button.disabled = locked || sending; });
}

function validateDelivery(total) {
  const { address, phone, payment, cash } = draft.delivery;
  byId('delivery-address').setCustomValidity(address && !address.trim() ? 'Escribe la dirección de entrega.' : '');
  const digits = phone.replace(/\D/g, '').length;
  const invalidPhone = phone && (!/^\+?[\d ().-]+$/.test(phone.trim()) || digits < 7 || digits > 15);
  byId('delivery-phone').setCustomValidity(invalidPhone ? 'Introduce un teléfono de 7 a 15 cifras.' : '');
  let cashError = '';
  const tender = parseCents(cash);
  if (payment === 'change' && cash.trim()) {
    if (tender === null) cashError = 'Escribe un importe con un máximo de dos decimales.';
    else if (tender < total) cashError = 'El importe que entrega debe cubrir el total, incluido el reparto.';
  }
  byId('cash-tender').setCustomValidity(cashError);
  return tender !== null && tender >= total ? tender - total : null;
}

function renderTotals() {
  const subtotal = draft.lines.reduce((sum, line) => sum + line.expectedCents * line.quantity, 0);
  const quantity = draft.lines.reduce((sum, line) => sum + line.quantity, 0);
  const isDelivery = draft.service === 'delivery';
  const zone = isDelivery ? zones[draft.delivery.zone] : null;
  const fee = zone?.[1] ?? 0;
  const total = subtotal + fee;
  const change = validateDelivery(total);
  const needsChange = isDelivery && draft.delivery.payment === 'change';
  byId('delivery-summary').hidden = !isDelivery;
  byId('order-subtotal').textContent = money(subtotal);
  byId('delivery-fee').textContent = zone ? money(fee) : 'Selecciona la zona';
  byId('change-row').hidden = !needsChange || !zone || change === null;
  byId('delivery-change').textContent = change === null ? '' : money(change);
  byId('order-total').textContent = money(total);
  byId('draft-count').textContent = `(${quantity})`;
  byId('draft-link').hidden = !quantity;
}

function renderService() {
  const pickup = draft.service === 'pickup';
  const delivery = draft.service === 'delivery';
  const cash = delivery && draft.delivery.payment === 'change';
  byId('service-selector').querySelector(`[value="${draft.service}"]`).checked = true;
  byId('pickup-fields').hidden = !pickup;
  byId('pickup-fields').disabled = !pickup;
  byId('delivery-fields').hidden = !delivery;
  byId('delivery-fields').disabled = !delivery;
  byId('cash-tender-label').hidden = !cash;
  byId('cash-tender').disabled = !cash;
  renderTableSelection();
}

function renderDraft() {
  byId('pickup-reference').value = draft.reference;
  byId('delivery-zone').value = draft.delivery.zone;
  byId('delivery-address').value = draft.delivery.address;
  byId('delivery-phone').value = draft.delivery.phone;
  byId('delivery-payment').value = draft.delivery.payment;
  byId('cash-tender').value = draft.delivery.cash;
  byId('order-note').value = draft.note;
  byId('empty-draft').hidden = draft.lines.length > 0;
  cartList.innerHTML = draft.lines.map((line, index) => {
    const name = escapeHtml(line.name);
    const variant = escapeHtml(line.expectedVariant);
    const chosen = selectedOffer(line);
    const changed = menu && !draft.submission && !currentLine(line, chosen);
    const review = chosen
      ? `<button type="button" class="secondary update-line" data-update="${index}">Usar opción actual · ${escapeHtml(money(chosen.offer.cents))}</button>`
      : '<p class="line-warning">Esta opción ya no está disponible. Quítala y elige otra en la carta.</p>';
    return `<li class="draft-line" data-line="${index}">
      <div class="draft-line-title"><div><strong>${name}</strong>${variant ? `<span>${variant}</span>` : ''}</div><output>${escapeHtml(money(line.expectedCents * line.quantity))}</output></div>
      <label>Cantidad <span class="sr-only">de ${name}</span><input type="number" data-quantity min="1" max="99" step="1" inputmode="numeric" value="${escapeHtml(line.quantity)}" required></label>
      <label>Nota <span class="sr-only">para ${name}, opcional</span><input data-line-note type="text" maxlength="160" autocomplete="off" value="${escapeHtml(line.note)}"></label>
      <button type="button" class="secondary remove-line" data-remove="${index}" aria-label="Quitar ${name}">×</button>
      ${changed ? review : ''}
    </li>`;
  }).join('');
  renderService();
  renderTotals();
  updateDraftControls();
}

function draftChanged() {
  feedback('draft-feedback');
  persistDraft();
}

function productAdded(button) {
  if (draft.submission || !menu) return;
  const item = menu.items.find(candidate => candidate.id === button.dataset.product);
  const index = Number(button.dataset.option);
  const offer = item?.prices[index];
  if (!offer) return;
  const existing = draft.lines.find(line => line.itemId === item.id && line.priceIndex === index &&
    currentLine(line) && !line.note && line.quantity < 99);
  if (existing) {
    existing.quantity++;
  } else if (draft.lines.length < maxLines) {
    draft.lines.push({
      itemId: item.id, name: item.name, priceIndex: index, expectedVariant: offer.label,
      expectedCents: offer.cents, quantity: 1, note: '',
    });
  } else {
    feedback('catalog-announcement', `La comanda admite hasta ${maxLines} líneas.`, true);
    feedback('draft-feedback', `La comanda admite hasta ${maxLines} líneas.`, true);
    return;
  }
  draftChanged();
  renderDraft();
  const quantity = draft.lines.reduce((sum, line) => sum + line.quantity, 0);
  feedback('catalog-announcement', `Producto añadido. ${quantity} ${quantity === 1 ? 'unidad' : 'unidades'} en la comanda.`);
}

function confirmSubmission(order) {
  draft = blankDraft();
  lastTableOrder = order.service === 'table' ? { tableNumber: order.tableNumber, accountNumber: order.accountNumber } : null;
  persistDraft();
  renderDraft();
  if (order.service === 'table') {
    viewedTable = order.tableNumber;
    renderFloor();
    void refreshTables({ afterChange: true });
  }
  feedback('draft-feedback', `Comanda #${order.number} registrada. Consulta el estado en Comandas recientes.`);
}

function servicePayload() {
  if (draft.service === 'table') {
    if (!tableMatchesDraft()) return null;
    return { service: 'table', tableNumber: draft.tableNumber, expectedAccountId: draft.expectedAccountId };
  }
  if (draft.service === 'pickup') return { service: 'pickup', reference: draft.reference.trim() };
  const { zone, address, phone, payment, cash } = draft.delivery;
  const delivery = { zone, address: address.trim(), phone: phone.trim(), payment };
  if (payment === 'change' && cash.trim()) delivery.cashCents = parseCents(cash);
  return { service: 'delivery', delivery };
}

async function sendOrder() {
  if (sending || signingOut || workspace.hidden) return;
  if (!draft.submission) {
    const details = servicePayload();
    if (!details) return;
    if (!menu || !draft.lines.length || draft.lines.some(line => !currentLine(line))) return;
    draft.submission = {
      id: crypto.randomUUID(), ...details, note: draft.note.trim(), menuRevision,
      lines: draft.lines.map(({ name, ...line }) => ({ ...line, note: line.note.trim() })),
    };
    persistDraft();
  }
  sending = true;
  feedback('draft-feedback');
  updateDraftControls();
  try {
    const { order } = await api('comandas', draft.submission);
    if (!order || order.id !== draft.submission.id) throw new Error('La web no ha confirmado la comanda.');
    confirmSubmission(order);
    void refreshHistory();
  } catch (error) {
    if (checkExpired(error)) return;
    if (error.explained && [400, 409, 413, 422].includes(error.status)) {
      draft.submission = null;
      persistDraft();
      feedback('draft-feedback', error.message, true);
      if (error.code === 'TABLE_CHANGED') {
        draft.tableNumber = null;
        draft.expectedAccountId = null;
        persistDraft();
        renderDraft();
        await refreshTables({ afterChange: true });
      } else if (error.code === 'MENU_CHANGED') {
        await refreshCatalog({ review: true });
      }
    } else {
      feedback('draft-feedback', `${error.message} Puedes reintentar con la misma referencia.`, true);
    }
  } finally {
    sending = false;
    updateDraftControls();
  }
}

function renderHistory(orders) {
  const signature = JSON.stringify(orders);
  if (historySignature === signature) return;
  historySignature = signature;
  const opened = new Set([...orderList.querySelectorAll('details[open]')].map(element => element.dataset.order));
  const focus = orderList.contains(document.activeElement) ? document.activeElement : null;
  const focusedOrder = focus?.closest('details')?.dataset.order;
  orderList.innerHTML = orders.map(order => {
    const [label, description] = states[order.status] ?? ['Estado desconocido', 'Actualiza el historial.'];
    const id = escapeHtml(order.id);
    const number = escapeHtml(order.number);
    const zone = zones[order.delivery?.zone];
    const service = order.service === 'table' ? `Mesa ${order.tableNumber}` : order.service === 'pickup'
      ? ['Para recoger', order.reference].filter(Boolean).join(' · ')
      : order.service === 'delivery' ? ['A domicilio', zone?.[0]].filter(Boolean).join(' · ') : order.table;
    const table = escapeHtml(service);
    const time = new Date(order.createdAt);
    const timestamp = Number.isFinite(time.getTime()) ? `<time datetime="${time.toISOString()}">${localTime.format(time)}</time>` : '';
    const lines = order.lines.map(line => `<li>${escapeHtml(line.quantity)} × ${escapeHtml(line.name)}${line.variant ? ` · ${escapeHtml(line.variant)}` : ''}${line.note ? `<span class="history-line-note">${escapeHtml(line.note)}</span>` : ''}</li>`).join('');
    const delivery = order.delivery;
    const hasTender = delivery?.payment === 'change' && Number.isInteger(delivery.cashCents);
    const deliveryDetails = delivery ? `<p><strong>Entrega</strong> · ${escapeHtml(delivery.address)} · ${escapeHtml(delivery.phone)}</p>
      <p>${escapeHtml(deliveryPayments[delivery.payment])}${hasTender ? ` · Entrega ${money(delivery.cashCents)} · Cambio ${money(delivery.cashCents - order.totalCents)}` : ''}</p>
      <p>Productos ${money(order.subtotalCents)} · Reparto ${money(order.deliveryFeeCents)}</p>` : '';
    const canReprint = ['sent', 'failed', 'uncertain'].includes(order.status);
    return `<li><details data-order="${id}" ${opened.has(order.id) ? 'open' : ''}>
      <summary><strong>#${number} · ${table}</strong><span class="order-state" data-state="${escapeHtml(order.status)}">${label}</span></summary>
      <div class="history-content">
        <p>${timestamp}${timestamp ? ' · ' : ''}${escapeHtml(money(order.totalCents))}${order.accountNumber ? ` · Cuenta #${escapeHtml(order.accountNumber)}` : ''}</p>
        ${deliveryDetails}
        <ol>${lines}</ol>
        ${order.note ? `<p><strong>Nota general</strong> · ${escapeHtml(order.note)}</p>` : ''}
        <p>${description}</p>
        ${order.printError ? `<p class="history-error">${escapeHtml(order.printError)}</p>` : ''}
        ${canReprint ? `<button class="secondary" type="button" data-reprint="${id}" data-attempt="${escapeHtml(order.attempt)}" data-number="${number}" data-table="${table}">Reimprimir</button>` : ''}
      </div>
    </details></li>`;
  }).join('');
  if (focusedOrder) {
    const row = [...orderList.querySelectorAll('details')].find(element => element.dataset.order === focusedOrder);
    const replacement = focus?.matches('[data-reprint]') ? row?.querySelector('[data-reprint]') : null;
    (replacement ?? row?.querySelector('summary'))?.focus();
  }
}

async function refreshHistory() {
  if (loadingHistory || workspace.hidden) return;
  const version = accessVersion;
  loadingHistory = true;
  byId('refresh-orders').disabled = true;
  if (historySignature === null) feedback('history-feedback', 'Cargando comandas…');
  try {
    const { orders } = await api('comandas');
    if (version !== accessVersion) return;
    renderHistory(orders);
    feedback('history-feedback', orders.length ? '' : 'Todavía no hay comandas.');
    const known = draft.submission && !sending && orders.find(order => order.id === draft.submission.id);
    if (known) confirmSubmission(known);
  } catch (error) {
    if (version === accessVersion && !checkExpired(error)) feedback('history-feedback', error.message, true);
  } finally {
    loadingHistory = false;
    byId('refresh-orders').disabled = false;
    if (version !== accessVersion && !workspace.hidden) void refreshHistory();
  }
}

async function reprintOrder(order) {
  feedback('history-action-feedback', `Enviando la copia de la comanda #${order.number}…`);
  try {
    await api('comandas/reimprimir', { id: order.id, attempt: order.attempt });
    feedback('history-action-feedback', `Copia de la comanda #${order.number} añadida a la cola.`);
  } catch (error) {
    if (!checkExpired(error)) {
      feedback('history-action-feedback', `${error.message} Consulta el estado de la comanda antes de repetir.`, true);
    }
  } finally {
    reprinting = null;
    void refreshHistory();
  }
}

byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = byId('access-code');
  event.submitter.disabled = true;
  feedback('access-feedback');
  try {
    await api('login', { code: input.value.trim() });
    input.value = '';
    await checkAccess();
    if (!workspace.hidden) byId('product-search').focus();
  } catch (error) {
    feedback('access-feedback', error.message, true);
  } finally {
    event.submitter.disabled = false;
  }
});

closeSession.addEventListener('click', async () => {
  if (sending || signingOut || billing.busy) return;
  if (draft.submission && !window.confirm('Hay una comanda sin confirmar. Si sales, se borrará el borrador de esta pestaña. ¿Salir?')) return;
  signingOut = true;
  updateDraftControls();
  try {
    await api('logout', {});
    setSession(false);
    draft = blankDraft();
    viewedTable = null;
    lastTableOrder = null;
    tableCountEdited = false;
    billing.clearSplits();
    persistDraft();
    renderDraft();
    feedback('access-feedback');
    byId('access-code').focus();
  } catch (error) {
    feedback('access-feedback', error.message, true);
  } finally {
    signingOut = false;
    updateDraftControls();
  }
});

byId('retry-access').addEventListener('click', () => void checkAccess());
byId('refresh-catalog').addEventListener('click', () => void refreshCatalog());
byId('refresh-orders').addEventListener('click', () => void refreshHistory());
byId('draft-link').addEventListener('click', () => byId('draft-heading').focus());
byId('order-note').addEventListener('input', event => { draft.note = event.target.value; draftChanged(); });
byId('pickup-reference').addEventListener('input', event => { draft.reference = event.target.value; draftChanged(); });
byId('service-selector').addEventListener('change', event => {
  lastTableOrder = null;
  draft.service = event.target.value;
  draftChanged();
  renderService();
  renderTotals();
  updateDraftControls();
});

const deliveryFields = {
  'delivery-zone': 'zone', 'delivery-address': 'address', 'delivery-phone': 'phone', 'delivery-payment': 'payment', 'cash-tender': 'cash',
};
for (const [id, field] of Object.entries(deliveryFields)) {
  byId(id).addEventListener('input', event => {
    draft.delivery[field] = event.target.value;
    if (field === 'payment') renderService();
    draftChanged();
    renderTotals();
  });
}

tableGrid.addEventListener('click', event => {
  const button = event.target.closest('[data-table-number]');
  const table = button && tableAt(Number(button.dataset.tableNumber));
  if (!table) return;
  lastTableOrder = null;
  viewedTable = table.number;
  if (!draft.submission && !sending) {
    draft.service = 'table';
    draft.tableNumber = table.number;
    draft.expectedAccountId = table.account?.id ?? null;
    draft.priorReference = '';
    draftChanged();
    renderService();
    renderTotals();
  }
  renderFloor();
});

byId('refresh-tables').addEventListener('click', () => void refreshTables());
byId('open-bill').addEventListener('click', () => billing.open(viewedTable));
byId('table-settings-form').addEventListener('submit', event => void saveTableCount(event));
byId('table-count').addEventListener('input', () => {
  tableCountEdited = true;
  byId('save-table-count').disabled = savingTables || !floor;
  feedback('table-settings-feedback');
});

for (const [id, event] of [['product-search', 'input'], ['category-filter', 'change']]) {
  byId(id).addEventListener(event, () => { showing = catalogPageSize; renderCatalog(); });
}

byId('more-products').addEventListener('click', () => {
  const first = productList.children.length;
  showing += catalogPageSize;
  renderCatalog();
  productList.children[first]?.querySelector('button')?.focus();
});

productList.addEventListener('click', event => {
  const button = event.target.closest('[data-product]');
  if (button) productAdded(button);
});

cartList.addEventListener('input', event => {
  const element = event.target;
  const row = element.closest('[data-line]');
  const line = row && draft.lines[Number(row.dataset.line)];
  if (!line || draft.submission) return;
  if (element.matches('[data-quantity]') && element.validity.valid) {
    line.quantity = element.valueAsNumber;
    row.querySelector('output').textContent = money(line.expectedCents * line.quantity);
    renderTotals();
  }
  if (element.matches('[data-line-note]')) line.note = element.value;
  draftChanged();
});

cartList.addEventListener('click', event => {
  const button = event.target.closest('[data-remove], [data-update]');
  if (!button || draft.submission) return;
  const index = Number(button.dataset.remove ?? button.dataset.update);
  if (button.hasAttribute('data-remove')) {
    draft.lines.splice(index, 1);
  } else {
    const line = draft.lines[index];
    const chosen = selectedOffer(line);
    if (!chosen) return;
    Object.assign(line, { priceIndex: chosen.index, expectedCents: chosen.offer.cents, name: chosen.item.name });
  }
  draftChanged();
  renderDraft();
  (cartList.children[Math.min(index, draft.lines.length - 1)]?.querySelector('[data-quantity]') ?? byId('product-search')).focus();
});

draftForm.addEventListener('submit', event => { event.preventDefault(); void sendOrder(); });

orderList.addEventListener('click', event => {
  const button = event.target.closest('[data-reprint]');
  if (!button || reprinting) return;
  reprinting = { id: button.dataset.reprint, number: button.dataset.number, attempt: Number(button.dataset.attempt) };
  byId('reprint-reference').textContent = `Comanda #${reprinting.number} · ${button.dataset.table}`;
  reprintDialog.returnValue = 'cancel';
  reprintDialog.showModal();
});

reprintDialog.addEventListener('close', () => {
  if (reprintDialog.returnValue === 'reprint' && reprinting) void reprintOrder(reprinting);
  else reprinting = null;
});

function refreshLive() {
  if (document.hidden) return;
  void refreshHistory();
  void refreshTables();
}
document.addEventListener('visibilitychange', refreshLive);
setInterval(refreshLive, 6000);
void checkAccess();
