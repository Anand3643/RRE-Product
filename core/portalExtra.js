/**
 * Customer dashboard extras (package tracking, purchase history, dashboard summary, customer assistant).
 * Every function receives `portal` = { partyId, ... } built by portal.portalOnly from the DATABASE (the signed-in customer's own
 * linked customer account), never from anything the browser sends. Every query is filtered by that id.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const portal = require('./portal');
const { get, all } = db;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const money = (n) => '₹' + r2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => '\\' + c)}%`;

// ---------------------------------------------------------------------------------------------------- tracking
const STEPS = [['confirmed', 'Order confirmed'], ['processing', 'Processing'], ['packed', 'Packed'], ['dispatched', 'Dispatched'], ['shipped', 'Shipped'], ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered']];
const LABEL = { ...Object.fromEntries(STEPS), placed: 'Order placed', cancelled: 'Cancelled', ready_to_ship: 'Packed', in_transit: 'Shipped', failed_delivery: 'Delivery attempt failed', returned: 'Returned' };
const stepOf = (s) => ({ ready_to_ship: 'packed', in_transit: 'shipped', failed_delivery: 'out_for_delivery' }[s] || s);
const COURIERS = [
  [/dtdc/i, (n) => `https://www.dtdc.in/tracking/shipment-tracking.asp?strCnno=${encodeURIComponent(n)}`],
  [/delhivery/i, (n) => `https://www.delhivery.com/track/package/${encodeURIComponent(n)}`],
  [/blue ?dart/i, (n) => `https://www.bluedart.com/tracking?trackFor=0&trackNo=${encodeURIComponent(n)}`],
  [/india ?post|speed ?post/i, (n) => `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?consignment=${encodeURIComponent(n)}`],
  [/fedex/i, (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`],
  [/dhl/i, (n) => `https://www.dhl.com/in-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`],
  [/ups/i, (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`],
  [/ekart/i, (n) => `https://ekartlogistics.com/shipmenttrack/${encodeURIComponent(n)}`]
];
const trackingLink = (carrier, no) => { if (!carrier || !no) return null; const c = COURIERS.find(([re]) => re.test(carrier)); return c ? c[1](no) : null; };
const iso = (d) => (d ? String(d).slice(0, 10) : null);

/** Shipments of the inventory application that belong to THIS customer (read-only look at its database, linked by the customer map). */
async function inventoryShipments(partyId) {
  const file = path.join(db.getDataDir(), 'inventory', 'stockpilot.db');
  if (!fs.existsSync(file)) return [];
  const ids = (await all("SELECT DISTINCT src_id FROM inv_import_map WHERE kind = 'customer' AND rre_id = ?", [partyId]).catch(() => [])).map((r) => parseInt(r.src_id, 10)).filter(Boolean);
  if (!ids.length) return [];
  let src;
  try { src = await require('./invImport').openSource(file); } catch (e) { return []; }
  try {
    const marks = ids.map(() => '?').join(',');
    const rows = await src.q(`SELECT s.id, s.number, s.carrier, s.tracking_number, s.status, s.shipping_date, s.expected_delivery, s.delivered_at, so.number AS order_number, so.order_date FROM shipments s JOIN sales_orders so ON so.id = s.so_id WHERE so.customer_id IN (${marks}) ORDER BY s.id DESC LIMIT 100`, ids);
    const out = [];
    for (const s of rows) {
      const ev = await src.q('SELECT status, note, location, occurred_at FROM shipment_events WHERE shipment_id = ? ORDER BY id', [s.id]).catch(() => []);
      out.push({ kind: 'shipment', id: 's' + s.id, number: s.number, order_number: s.order_number, order_date: iso(s.order_date), status: stepOf(s.status), status_label: LABEL[s.status] || LABEL[stepOf(s.status)] || s.status, carrier: s.carrier || null, tracking_number: s.tracking_number || null, tracking_url: trackingLink(s.carrier, s.tracking_number), shipped_on: iso(s.shipping_date), expected_delivery: iso(s.expected_delivery), delivered_on: iso(s.delivered_at),
        events: ev.map((e) => ({ status: LABEL[e.status] || e.status, note: e.note || null, location: e.location || null, at: e.occurred_at })) });
    }
    return out;
  } catch (e) { return []; } finally { src.close(); }
}

/** All of this customer's packages: courier shipments where they exist, and every order with where it stands. */
async function packages(p) {
  const orders = await all("SELECT id, number, status, order_date, expected_date, total FROM inv_orders WHERE kind = 'sales' AND party_ledger_id = ? ORDER BY id DESC LIMIT 100", [p.partyId]);
  const rows = orders.map((o) => {
    const st = o.status === 'draft' ? 'placed' : o.status === 'confirmed' ? 'processing' : o.status === 'invoiced' ? 'dispatched' : o.status;
    return { kind: 'order', id: 'o' + o.id, number: o.number, order_number: o.number, order_date: o.order_date, status: st, status_label: o.status === 'invoiced' ? 'Invoiced, being dispatched' : LABEL[st] || st, expected_delivery: o.expected_date || null, total: o.total, carrier: null, tracking_number: null, tracking_url: null, events: [] };
  });
  const ship = await inventoryShipments(p.partyId);
  const shippedOrders = new Set(ship.map((s) => s.order_number));
  const all_ = [...ship, ...rows.filter((r) => !shippedOrders.has(r.number))];
  const steps = STEPS.map(([k, l]) => ({ key: k, label: l }));
  return { items: all_, steps, counts: { total: all_.length, delivered: all_.filter((x) => x.status === 'delivered').length, in_transit: all_.filter((x) => ['dispatched', 'shipped', 'out_for_delivery', 'packed'].includes(x.status)).length, pending: all_.filter((x) => ['placed', 'processing', 'confirmed'].includes(x.status)).length } };
}

// ---------------------------------------------------------------------------------------------------- purchase history
async function history(p, q = {}) {
  const status = String(q.status || '');
  const rows = [];
  const w = ['o.kind = \'sales\'', 'o.party_ledger_id = ?'], pa = [p.partyId];
  if (q.from && ISO.test(q.from)) { w.push('o.order_date >= ?'); pa.push(q.from); }
  if (q.to && ISO.test(q.to)) { w.push('o.order_date <= ?'); pa.push(q.to); }
  if (q.q) { w.push("(o.number LIKE ? ESCAPE '\\' OR o.reference LIKE ? ESCAPE '\\')"); pa.push(like(q.q), like(q.q)); }
  if (['draft', 'confirmed', 'invoiced', 'cancelled'].includes(status)) { w.push('o.status = ?'); pa.push(status); }
  if (!status || ['draft', 'confirmed', 'invoiced', 'cancelled'].includes(status)) {
    for (const o of await all(`SELECT o.id, o.number, o.status, o.order_date AS date, o.total, o.reference, (SELECT COUNT(*) FROM inv_order_lines WHERE order_id = o.id) AS lines FROM inv_orders o WHERE ${w.join(' AND ')} ORDER BY o.id DESC LIMIT 300`, pa)) rows.push({ kind: 'order', id: o.id, number: o.number, date: o.date, status: o.status, status_label: { draft: 'Awaiting confirmation', confirmed: 'Confirmed', invoiced: 'Invoiced', cancelled: 'Cancelled' }[o.status], total: o.total, reference: o.reference, items: o.lines });
  }
  if (!status || status === 'invoice') {
    const vw = ["v.party_ledger_id = ?", "v.voucher_type IN ('Sales', 'Credit Note')"], vp = [p.partyId];
    if (q.from && ISO.test(q.from)) { vw.push('v.date >= ?'); vp.push(q.from); }
    if (q.to && ISO.test(q.to)) { vw.push('v.date <= ?'); vp.push(q.to); }
    if (q.q) { vw.push("(v.voucher_no LIKE ? ESCAPE '\\' OR v.reference_no LIKE ? ESCAPE '\\')"); vp.push(like(q.q), like(q.q)); }
    for (const v of await all(`SELECT v.id, v.voucher_no AS number, v.voucher_type AS type, v.date, v.total_amount AS total, v.reference_no AS reference, (SELECT COUNT(*) FROM inventory_entries e WHERE e.voucher_id = v.id) AS items FROM vouchers v WHERE ${vw.join(' AND ')} ORDER BY v.date DESC, v.id DESC LIMIT 300`, vp)) rows.push({ kind: 'invoice', id: v.id, number: v.number, date: v.date, status: 'invoice', status_label: v.type === 'Credit Note' ? 'Credit note' : 'Invoice', total: v.total, reference: v.reference, items: v.items });
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.id - a.id));
  return { items: rows.slice(0, 300), total: rows.length };
}

// ---------------------------------------------------------------------------------------------------- dashboard
async function dashboard(p) {
  const c = async (st) => (await get("SELECT COUNT(*) c FROM inv_orders WHERE kind = 'sales' AND party_ledger_id = ? AND status = ?", [p.partyId, st])).c;
  const total = (await get("SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total END), 0) s FROM inv_orders WHERE kind = 'sales' AND party_ledger_id = ?", [p.partyId]));
  const pkg = await packages(p);
  const base = await portal.summary(p);
  const user = await get('SELECT full_name, email, phone, created_at FROM users WHERE id = ?', [p.userId]);
  const notes = [];
  for (const s of pkg.items.slice(0, 20)) {
    if (s.kind === 'shipment' && s.status === 'delivered') notes.push({ at: s.delivered_on, text: `Order ${s.order_number} was delivered.` });
    else if (s.kind === 'shipment') notes.push({ at: s.shipped_on, text: `Order ${s.order_number}: ${s.status_label}${s.expected_delivery ? ', expected ' + s.expected_delivery : ''}.` });
  }
  for (const o of base.recent_orders) { if (o.status === 'confirmed') notes.push({ at: o.order_date, text: `Your order ${o.number} was confirmed.` }); if (o.status === 'cancelled') notes.push({ at: o.order_date, text: `Order ${o.number} was cancelled.` }); }
  for (const i of base.recent_invoices) notes.push({ at: i.date, text: `${i.type === 'Credit Note' ? 'Credit note' : 'Invoice'} ${i.number} for ${money(i.total)} is available.` });
  notes.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { customer: p.party.name, full_name: user.full_name, email: user.email, phone: user.phone, member_since: String(user.created_at || '').slice(0, 10),
    orders: { total: total.c, pending: (await c('draft')) + (await c('confirmed')), completed: await c('invoiced'), cancelled: await c('cancelled'), spent: r2(total.s) },
    packages: pkg.counts, recent_purchases: (await history(p, {})).items.slice(0, 5), notifications: notes.slice(0, 8) };
}

// ---------------------------------------------------------------------------------------------------- customer assistant
const HELP = 'I can help with your own orders and purchases. Try: "Where is my latest order?", "Show my pending orders", "How much have I spent?", "Explain my last invoice", "What is in stock?", or "Recommend something for me".';
const hasAny = (q, words) => words.some((w) => q.includes(w));

async function assistant(p, questionRaw) {
  const question = String(questionRaw || '').trim().slice(0, 400);
  if (question.length < 2) return { answer: HELP, suggestions: ['Where is my latest order?', 'How much have I spent?', 'Recommend something for me'] };
  const q = question.toLowerCase();
  const numberMatch = /\b([A-Za-z]{1,6}[-/ ]?\d{2,}[A-Za-z0-9\-/]*)\b/.exec(question);
  const orders = await all("SELECT id, number, status, order_date, expected_date, total FROM inv_orders WHERE kind = 'sales' AND party_ledger_id = ? ORDER BY id DESC LIMIT 100", [p.partyId]);
  const ST = { draft: 'awaiting confirmation by the business', confirmed: 'confirmed and being processed', invoiced: 'invoiced', cancelled: 'cancelled' };
  const name = (portalName) => portalName;

  // a specific number (only ever looked up inside THIS customer's records)
  if (numberMatch && hasAny(q, ['order', 'invoice', 'package', 'shipment', 'track', 'status', 'where'])) {
    const no = numberMatch[1].replace(/\s+/g, '').toLowerCase();
    const o = orders.find((x) => x.number.replace(/\s+/g, '').toLowerCase() === no);
    if (o) {
      const lines = await all('SELECT s.name, l.qty, l.amount FROM inv_order_lines l JOIN stock_items s ON s.id = l.item_id WHERE l.order_id = ?', [o.id]);
      const ship = (await inventoryShipments(p.partyId)).find((s) => s.order_number === o.number);
      return { answer: `Order ${o.number} (${o.order_date}) is ${ST[o.status] || o.status}. Total ${money(o.total)}. Items: ${lines.map((l) => `${l.name} × ${l.qty}`).join(', ') || 'none'}.${ship ? ` Package: ${ship.status_label}${ship.carrier ? ' with ' + ship.carrier : ''}${ship.tracking_number ? ', tracking ' + ship.tracking_number : ''}${ship.expected_delivery ? ', expected ' + ship.expected_delivery : ''}.` : ''}`, data: { order: o.number } };
    }
    const v = await get("SELECT id, voucher_no, date, total_amount FROM vouchers WHERE party_ledger_id = ? AND voucher_type IN ('Sales','Credit Note') AND REPLACE(LOWER(voucher_no), ' ', '') = ?", [p.partyId, no]);
    if (v) return { answer: await explainInvoice(p, v.id) };
    return { answer: `I could not find "${numberMatch[1]}" in your orders or invoices. Check the number on your order or invoice.` };
  }

  if (hasAny(q, ['track', 'where is', 'delivery', 'deliver', 'package', 'shipment', 'shipped', 'dispatch', 'courier'])) {
    const pk = await packages(p);
    if (!pk.items.length) return { answer: 'You have no orders or packages yet.' };
    const lines = pk.items.slice(0, 4).map((s) => `${s.order_number}: ${s.status_label}${s.carrier ? ' (' + s.carrier + (s.tracking_number ? ', ' + s.tracking_number : '') + ')' : ''}${s.expected_delivery ? ', expected ' + s.expected_delivery : ''}`);
    return { answer: `Your latest packages:\n${lines.join('\n')}`, data: { go: 'packages' } };
  }
  if (hasAny(q, ['pending', 'awaiting', 'open order', 'not confirmed'])) {
    const pend = orders.filter((o) => o.status === 'draft' || o.status === 'confirmed');
    return { answer: pend.length ? `You have ${pend.length} pending order(s): ${pend.slice(0, 6).map((o) => `${o.number} (${o.status === 'draft' ? 'awaiting confirmation' : 'confirmed'}, ${money(o.total)})`).join('; ')}.` : 'You have no pending orders.' };
  }
  if (hasAny(q, ['how many order', 'total order', 'number of order', 'completed', 'cancelled'])) {
    const n = (s) => orders.filter((o) => o.status === s).length;
    return { answer: `You have ${orders.length} order(s): ${n('draft')} awaiting confirmation, ${n('confirmed')} confirmed, ${n('invoiced')} invoiced, ${n('cancelled')} cancelled.` };
  }
  if (hasAny(q, ['spent', 'spend', 'total purchase', 'how much', 'bought', 'purchase history', 'last purchase', 'recent purchase'])) {
    const inv = await all("SELECT voucher_no, date, voucher_type, total_amount FROM vouchers WHERE party_ledger_id = ? AND voucher_type IN ('Sales','Credit Note') ORDER BY date DESC, id DESC", [p.partyId]);
    if (!inv.length) return { answer: 'You have no invoices yet, so there are no purchases to total.' };
    const sum = inv.reduce((t, x) => t + (x.voucher_type === 'Credit Note' ? -x.total_amount : x.total_amount), 0);
    return { answer: `Across ${inv.length} invoice(s) you have been billed ${money(sum)} in total. Your latest is ${inv[0].voucher_no} on ${inv[0].date} for ${money(inv[0].total_amount)}.`, data: { go: 'history' } };
  }
  if (hasAny(q, ['invoice', 'bill', 'gst', 'tax', 'explain', 'receipt'])) {
    const v = await get("SELECT id FROM vouchers WHERE party_ledger_id = ? AND voucher_type IN ('Sales','Credit Note') ORDER BY date DESC, id DESC LIMIT 1", [p.partyId]);
    return { answer: v ? await explainInvoice(p, v.id) : 'You have no invoices yet.' };
  }
  if (hasAny(q, ['recommend', 'suggest', 'buy again', 'reorder', 'similar'])) {
    const rec = await recommendations(p);
    return { answer: rec.length ? `Based on what you bought before and what is in stock: ${rec.map((r) => `${r.name} (${money(r.price)}, ${r.availability_label})`).join('; ')}.` : 'There is nothing to recommend yet: place an order and I will learn what you like.', data: { go: 'catalogue' } };
  }
  if (hasAny(q, ['stock', 'available', 'availability', 'price', 'product', 'item', 'sell', 'have you got', 'do you have'])) {
    const words = q.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['stock', 'available', 'availability', 'price', 'product', 'products', 'item', 'items', 'have', 'you', 'got', 'the', 'what', 'which', 'for', 'and', 'with', 'sell', 'show', 'any', 'are', 'there', 'much', 'does', 'cost'].includes(w));
    const cat = await portal.catalogue({ q: words.join(' '), page_size: 6 });
    return { answer: cat.items.length ? `${words.length ? 'Matching' : 'Available'} products: ${cat.items.map((i) => `${i.name} — ${money(i.price)}, ${i.availability_label}`).join('; ')}.` : 'I could not find a matching product. Try a different word, or browse the catalogue.', data: { go: 'catalogue' } };
  }
  if (hasAny(q, ['profile', 'my account', 'my details', 'email', 'phone'])) {
    return { answer: `Your account is linked to customer "${p.party.name}". You can update your name and phone, and change your password, under My profile.`, data: { go: 'profile' } };
  }
  return { answer: HELP, suggestions: ['Where is my latest order?', 'How much have I spent?', 'Recommend something for me'] };
}

async function explainInvoice(p, id) {
  const inv = await portal.getInvoice(p, id);
  return `${inv.type === 'Credit Note' ? 'Credit note' : 'Invoice'} ${inv.number} dated ${inv.date}: items ${inv.items.map((i) => `${i.item} × ${i.qty} at ${money(i.rate)}${i.discount_pct ? ' (' + i.discount_pct + '% discount)' : ''}`).join(', ') || 'none'}. The items come to ${money(inv.taxable)} before tax; GST and rounding add ${money(inv.tax_and_rounding)}, so the total is ${money(inv.total)}.`;
}

async function recommendations(p) {
  const bought = await all("SELECT DISTINCT e.stock_item_id id FROM inventory_entries e JOIN vouchers v ON v.id = e.voucher_id WHERE v.party_ledger_id = ? AND v.voucher_type = 'Sales' LIMIT 40", [p.partyId]).catch(() => []);
  const cat = await portal.catalogue({ page_size: 60 });
  const boughtIds = new Set(bought.map((b) => b.id));
  const inStock = cat.items.filter((i) => i.availability !== 'out');
  const again = inStock.filter((i) => boughtIds.has(i.id)).slice(0, 3);
  const fresh = inStock.filter((i) => !boughtIds.has(i.id)).slice(0, 3 - again.length + 2);
  return [...again, ...fresh].slice(0, 5);
}

module.exports = { packages, history, dashboard, assistant, recommendations, trackingLink };
