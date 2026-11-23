const byId = id => document.getElementById(id);
const paymentPrefix = 'punto-cero:cobro-pendiente:';
const splitPrefix = 'punto-cero:reparto:';
const methodNames = { cash: 'Efectivo', card: 'Tarjeta' };

export function parseCents(text) {
  const match = String(text).trim().match(/^(\d+)(?:[.,](\d{1,2}))?$/);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function readStored(storage, key) {
  try { return JSON.parse(window[storage].getItem(key)); } catch { return null; }
}

function store(storage, key, value) {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, JSON.stringify(value));
  } catch {
    // The current tab retains the pending request when browser storage is unavailable.
  }
}

function storageKeys(storage, prefix) {
  try { return Object.keys(window[storage]).filter(key => key.startsWith(prefix)); } catch { return []; }
}

export function createBilling({ api, feedback, escapeHtml, money, localTime, checkExpired, onBusy, onChange }) {
  const dialog = byId('billing-dialog');
  const form = byId('bill-form');
  const resumeButton = byId('resume-payment');
  let account = null;
  let openedTable = null;
  let activeLookup = 0;
  let split = null;
  let pending = null;
  let sending = false;

  function savedRecovery() {
    const records = storageKeys('localStorage', paymentPrefix).map(key => readStored('localStorage', key));
    return records.find(record => record?.payload?.id && record.tableNumber) ?? null;
  }

  function renderPendingButton() {
    resumeButton.hidden = !pending && !savedRecovery();
  }

  function renderAccount() {
    byId('bill-details').hidden = !account;
    if (!account) return;
    byId('bill-total').textContent = money(account.totalCents);
    byId('bill-paid').textContent = money(account.paidCents);
    byId('bill-balance').textContent = money(account.remainingCents);
    byId('bill-orders').innerHTML = account.orders.map(order => {
      const products = order.lines.map(line => `${line.quantity} × ${line.name}${line.variant ? ` (${line.variant})` : ''}`);
      return `<li><strong>#${escapeHtml(order.number)} · ${money(order.totalCents)}</strong><br>${escapeHtml(products.join(', '))}</li>`;
    }).join('');
    byId('bill-payments-details').hidden = !account.payments.length;
    byId('bill-payments').innerHTML = account.payments.map(payment => {
      const date = new Date(payment.createdAt);
      const timestamp = Number.isFinite(date.getTime()) ? ` · ${localTime.format(date)}` : '';
      const method = payment.cents ? methodNames[payment.method] : 'Cierre sin importe';
      return `<li>${money(payment.cents)} · ${method}${timestamp}</li>`;
    }).join('');
  }

  function billingMode() {
    return form.querySelector('[name="billing-mode"]:checked').value;
  }

  function renderParts() {
    const firstDue = split?.parts.findIndex(part => part.cents > 0 && !part.paid);
    byId('bill-part-list').innerHTML = (split?.parts ?? []).map(({ cents, paid }, index) => {
      const label = `Parte ${index + 1} · ${money(cents)}`;
      if (paid || !cents) return `<li><span>${label}</span><span>${paid ? 'Cobrada' : 'Sin cargo'}</span></li>`;
      return `<li><label><input type="radio" name="bill-part" value="${index}" ${index === firstDue ? 'checked' : ''}> ${label}</label></li>`;
    }).join('');
  }

  function selection() {
    if (!account) return { cents: null };
    const mode = billingMode();
    if (mode === 'full' || account.remainingCents === 0) return { cents: account.remainingCents };
    if (mode === 'custom') return { cents: parseCents(byId('bill-custom').value) };
    const option = form.querySelector('[name="bill-part"]:checked');
    const partIndex = option ? Number(option.value) : undefined;
    const part = split?.parts[partIndex];
    return { cents: part && !part.paid ? part.cents : null, partIndex };
  }

  function updateForm() {
    const visible = Boolean(pending || (account && !account.closedAt));
    form.hidden = !visible;
    const hasAmount = Boolean(account?.remainingCents);
    const mode = billingMode();
    byId('bill-split-controls').hidden = Boolean(pending || !hasAmount);
    byId('bill-equal').hidden = Boolean(pending || !hasAmount || mode !== 'equal');
    byId('bill-custom-label').hidden = Boolean(pending || !hasAmount || mode !== 'custom');
    byId('bill-method').hidden = Boolean(pending || !hasAmount);
    byId('bill-method').disabled = Boolean(pending || !hasAmount || sending);
    byId('bill-split-controls').disabled = sending;
    byId('bill-instructions').hidden = Boolean(pending || !hasAmount);
    byId('bill-pending').hidden = !pending;
    byId('bill-pending').textContent = pending
      ? `Registro pendiente de confirmar · ${money(pending.payload.cents)} · ${methodNames[pending.payload.method]}. Reintenta el registro del mismo cobro.`
      : '';
    const { cents } = selection();
    const valid = cents !== null && (hasAmount ? cents > 0 && cents <= account.remainingCents : cents === 0);
    const method = form.querySelector('[name="bill-method"]:checked');
    byId('record-payment').disabled = sending || (!pending && (!visible || !valid || (hasAmount && !method)));
    byId('record-payment').textContent = sending ? 'Registrando…' : pending ? 'Reintentar registro' :
      !hasAmount ? 'Cerrar cuenta sin importe' : valid ? `Registrar cobro de ${money(cents)}` : 'Registrar cobro';
    byId('close-bill').disabled = sending;
    renderPendingButton();
  }

  function displayAccount(data) {
    account = data;
    const stored = account && readStored('sessionStorage', splitPrefix + account.id);
    split = stored?.version === account?.version ? stored : null;
    if (account && stored && !split) store('sessionStorage', splitPrefix + account.id, null);
    byId('billing-heading').textContent = account ? `Mesa ${openedTable} · Cuenta #${account.number}` : `Mesa ${openedTable}`;
    byId('bill-parts').value = String(split?.parts.length ?? 2);
    const mode = split ? 'equal' : 'full';
    form.querySelector(`[name="billing-mode"][value="${mode}"]`).checked = true;
    renderAccount();
    renderParts();
    updateForm();
  }

  async function loadAccount(tableNumber) {
    const lookup = ++activeLookup;
    feedback('billing-feedback', 'Cargando la cuenta…');
    try {
      const { account: data } = await api(`comandas/cuenta?table=${tableNumber}`);
      if (lookup !== activeLookup) return;
      displayAccount(data);
      feedback('billing-feedback', data ? '' : 'Esta mesa está libre.');
    } catch (error) {
      if (lookup === activeLookup && !checkExpired(error)) feedback('billing-feedback', error.message, true);
    }
  }

  function open(tableNumber) {
    if (sending || dialog.open) return;
    pending ??= savedRecovery();
    openedTable = pending?.tableNumber ?? tableNumber;
    if (!openedTable) return;
    activeLookup++;
    form.reset();
    displayAccount(null);
    feedback('billing-feedback');
    dialog.showModal();
    if (!pending) void loadAccount(openedTable);
  }

  function clearPending(record) {
    store('localStorage', paymentPrefix + record.payload.id, null);
    pending = null;
  }

  async function recordPayment() {
    if (sending) return;
    if (!pending) {
      const { cents, partIndex } = selection();
      const amountValid = account?.remainingCents === 0 ? cents === 0 : cents > 0 && cents <= account?.remainingCents;
      const method = cents === 0 ? 'cash' : form.querySelector('[name="bill-method"]:checked')?.value;
      if (!account || account.closedAt || !amountValid || !method) return;
      pending = {
        tableNumber: openedTable, partIndex,
        payload: { id: crypto.randomUUID(), accountId: account.id, version: account.version, cents, method },
      };
      store('localStorage', paymentPrefix + pending.payload.id, pending);
    }
    const record = pending;
    sending = true;
    onBusy();
    updateForm();
    feedback('billing-feedback');
    try {
      const { account: updated } = await api('comandas/cobrar', record.payload);
      if (updated?.id !== record.payload.accountId) throw new Error('La web no ha confirmado el cobro.');
      clearPending(record);
      const splitKey = splitPrefix + updated.id;
      const originalSplit = readStored('sessionStorage', splitKey);
      const part = originalSplit?.parts[record.partIndex];
      if (!updated.closedAt && part && originalSplit.version === record.payload.version && updated.version === record.payload.version + 1) {
        part.paid = true;
        originalSplit.version = updated.version;
        store('sessionStorage', splitKey, originalSplit);
      } else {
        store('sessionStorage', splitKey, null);
      }
      form.reset();
      displayAccount(updated);
      feedback('billing-feedback', updated.closedAt ? 'Cuenta saldada.' : `Cobro de ${money(record.payload.cents)} registrado.`);
      onChange();
    } catch (error) {
      if (checkExpired(error)) return;
      if (error.explained && [400, 404, 409, 413, 422].includes(error.status)) {
        clearPending(record);
        displayAccount(null);
        await loadAccount(openedTable);
        feedback('billing-feedback', `${error.message} Comprueba el pago recibido antes de volver a registrarlo.`, true);
        onChange();
      } else {
        feedback('billing-feedback', error.message, true);
      }
    } finally {
      sending = false;
      updateForm();
      onBusy();
    }
  }

  byId('calculate-split').addEventListener('click', () => {
    const input = byId('bill-parts');
    const count = input.valueAsNumber;
    if (!input.reportValidity() || !account?.remainingCents || !Number.isInteger(count) || count < 2 || count > 50) return;
    const quotient = Math.floor(account.remainingCents / count);
    const remainder = account.remainingCents % count;
    const parts = Array.from({ length: count }, (_, index) => ({ cents: quotient + Number(index < remainder), paid: false }));
    split = { version: account.version, parts };
    store('sessionStorage', splitPrefix + account.id, split);
    renderParts();
    updateForm();
    feedback('billing-feedback');
  });

  form.addEventListener('submit', event => { event.preventDefault(); void recordPayment(); });
  form.addEventListener('input', updateForm);
  byId('close-bill').addEventListener('click', () => { if (!sending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (sending) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!dialog.open) activeLookup++; });
  resumeButton.addEventListener('click', () => open(null));
  window.addEventListener('storage', event => { if (!event.key || event.key.startsWith(paymentPrefix)) renderPendingButton(); });

  return {
    open,
    renderPendingButton,
    get busy() { return sending; },
    close() {
      activeLookup++;
      if (dialog.open) dialog.close();
      account = null;
      renderAccount();
      byId('bill-orders').replaceChildren();
      byId('bill-payments').replaceChildren();
      byId('bill-payments-details').hidden = true;
    },
    clearSplits() {
      split = null;
      storageKeys('sessionStorage', splitPrefix).forEach(key => store('sessionStorage', key, null));
    },
  };
}
