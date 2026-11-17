require('dotenv').config();
const { run, get, all } = require('./db');

// Read config from environment (discovered & reconstructed via REA)
const ZOHO_DC = process.env.ZOHO_DC || 'com';
const ACCOUNTS_BASE = `https://accounts.zoho.${ZOHO_DC}/oauth/v2`;
const API_BASE = `https://www.zohoapis.${ZOHO_DC}/books/v3`;

let _token = { accessToken: null, expiresAt: 0 };

// Indian GST State Code mapping
const STATE_CODES = {
  'andaman and nicobar islands': 'AN', 'andhra pradesh': 'AP', 'arunachal pradesh': 'AR', 'assam': 'AS', 'bihar': 'BR',
  'chandigarh': 'CH', 'chhattisgarh': 'CT', 'delhi': 'DL', 'goa': 'GA', 'gujarat': 'GJ', 'haryana': 'HR',
  'himachal pradesh': 'HP', 'jammu and kashmir': 'JK', 'jharkhand': 'JH', 'karnataka': 'KA', 'kerala': 'KL',
  'ladakh': 'LA', 'madhya pradesh': 'MP', 'maharashtra': 'MH', 'manipur': 'MN', 'meghalaya': 'ML',
  'mizoram': 'MZ', 'nagaland': 'NL', 'odisha': 'OR', 'puducherry': 'PY', 'punjab': 'PB', 'rajasthan': 'RJ',
  'sikkim': 'SK', 'tamil nadu': 'TN', 'telangana': 'TG', 'tripura': 'TR', 'uttar pradesh': 'UP',
  'uttarakhand': 'UT', 'west bengal': 'WB'
};

const stateCodeOf = (state) => STATE_CODES[String(state || '').trim().toLowerCase()] || 'TN';
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// 1. Get / Refresh OAuth Access Token
async function getAccessToken() {
  if (_token.accessToken && Date.now() < _token.expiresAt - 60000) {
    return _token.accessToken;
  }

  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } = process.env;
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Zoho credentials missing in .env');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN
  });

  const res = await fetch(`${ACCOUNTS_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`Zoho token refresh failed: ${json.error || JSON.stringify(json)}`);
  }

  _token = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  };

  return _token.accessToken;
}

// 2. Base API Request Wrapper
async function zohoRequest(method, path, body = null) {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORGANIZATION_ID;
  if (!orgId) throw new Error('ZOHO_ORGANIZATION_ID not set');

  const sep = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}${path}${sep}organization_id=${orgId}`;

  const options = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const json = await res.json();

  if (json.code !== undefined && json.code !== 0) {
    throw new Error(json.message || `Zoho API error (code ${json.code})`);
  }

  return json;
}

// 3. Find or Create Contact in Zoho Books
async function findOrCreateContact(customer) {
  if (customer.zoho_contact_id) return customer.zoho_contact_id;

  const name = (customer.company || customer.name || '').trim();
  if (!name) throw new Error('Customer has no company name');

  const search = await zohoRequest('GET', `/contacts?contact_name_contains=${encodeURIComponent(name)}`);
  const candidates = search.contacts || [];

  const gstin = (customer.gstin || '').trim().toUpperCase();
  let match = gstin && candidates.find(c => (c.gst_no || '').trim().toUpperCase() === gstin);
  if (!match) match = candidates.find(c => normName(c.contact_name || c.company_name) === normName(name));

  let contactId;
  if (match) {
    contactId = match.contact_id;
  } else {
    const isSEZ = /\bSEZ\b/i.test(`${customer.address || ''} ${name}`);
    const created = await zohoRequest('POST', '/contacts', {
      contact_name: name,
      company_name: name,
      gst_no: customer.gstin || undefined,
      gst_treatment: isSEZ ? 'sez_wp' : (customer.gstin ? 'business_gst' : 'consumer'),
      billing_address: {
        address: customer.address || '',
        city: customer.city || 'Chennai',
        state: customer.state || 'Tamil Nadu',
        country: 'India'
      }
    });
    contactId = created.contact.contact_id;
  }

  await run('UPDATE customers SET zoho_contact_id = ? WHERE id = ?', [contactId, customer.id]);
  return contactId;
}

// 4. Find or Create Item in Zoho Books
async function findOrCreateItem(product) {
  if (product.zoho_item_id) return product.zoho_item_id;

  const name = (product.name || '').trim();
  const sku = (product.sku || '').trim();

  const search = await zohoRequest('GET', `/items?name_contains=${encodeURIComponent(name)}`);
  const candidates = search.items || [];

  let match = sku && candidates.find(it => (it.sku || '').trim().toUpperCase() === sku.toUpperCase());
  if (!match) match = candidates.find(it => normName(it.name) === normName(name));

  let itemId;
  if (match) {
    itemId = match.item_id;
  } else {
    const created = await zohoRequest('POST', '/items', {
      name,
      rate: parseFloat(product.unit_price) || 0,
      sku: sku || undefined,
      hsn_or_sac: product.hsn_code || undefined,
      unit: product.unit || 'pcs'
    });
    itemId = created.item.item_id;
  }

  await run('UPDATE products SET zoho_item_id = ? WHERE id = ?', [itemId, product.id]);
  return itemId;
}

// 5. Push Quotation to Zoho Books as an Estimate
async function pushQuotationToZoho(quoteId) {
  const quote = await get('SELECT * FROM quotations WHERE id = ?', [quoteId]);
  if (!quote) throw new Error('Quotation not found');

  const customer = await get('SELECT * FROM customers WHERE id = ?', [quote.customer_id]);
  if (!customer) throw new Error('Customer not found for quotation');

  const contactId = await findOrCreateContact(customer);
  const items = await all('SELECT * FROM quotation_items WHERE quotation_id = ?', [quote.id]);

  const lineItems = [];
  for (const it of items) {
    let zohoItemId;
    if (it.product_id) {
      const prod = await get('SELECT * FROM products WHERE id = ?', [it.product_id]);
      if (prod) zohoItemId = await findOrCreateItem(prod);
    }
    lineItems.push({
      item_id: zohoItemId,
      name: it.description,
      rate: it.unit_price,
      quantity: it.quantity,
      discount: it.discount || 0
    });
  }

  const gstin = (customer.gstin || '').trim();
  const isSEZ = /\bSEZ\b/i.test(`${customer.address || ''} ${customer.company || ''}`);

  const payload = {
    customer_id: contactId,
    estimate_number: quote.quote_no,
    date: quote.quote_date,
    expiry_date: quote.valid_until || undefined,
    line_items: lineItems,
    gst_treatment: isSEZ ? 'sez_wp' : (gstin ? 'business_gst' : 'consumer'),
    gst_no: gstin || undefined,
    place_of_supply: stateCodeOf(customer.state)
  };

  const existing = quote.zoho_estimate_id;
  const result = existing
    ? await zohoRequest('PUT', `/estimates/${existing}`, payload)
    : await zohoRequest('POST', '/estimates', payload);

  const estimateId = result.estimate.estimate_id;
  await run('UPDATE quotations SET zoho_estimate_id = ? WHERE id = ?', [estimateId, quote.id]);

  await run(
    `INSERT INTO zoho_sync_logs (entity_type, entity_id, zoho_id, status, message)
     VALUES ('Quotation', ?, ?, 'Success', ?)`,
    [quote.id, estimateId, `Synced to Zoho Estimate ${quote.quote_no}`]
  );

  return { estimate_id: estimateId, estimate_number: quote.quote_no };
}

// 6. Push Invoice to Zoho Books as a Tax Invoice
async function pushInvoiceToZoho(invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new Error('Invoice not found');

  const customer = await get('SELECT * FROM customers WHERE id = ?', [inv.customer_id]);
  if (!customer) throw new Error('Customer not found for invoice');

  const contactId = await findOrCreateContact(customer);
  const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ?', [inv.id]);

  const lineItems = [];
  for (const it of items) {
    let zohoItemId;
    if (it.product_id) {
      const prod = await get('SELECT * FROM products WHERE id = ?', [it.product_id]);
      if (prod) zohoItemId = await findOrCreateItem(prod);
    }
    lineItems.push({
      item_id: zohoItemId,
      name: it.description,
      rate: it.unit_price,
      quantity: it.quantity
    });
  }

  const gstin = (customer.gstin || '').trim();
  const isSEZ = /\bSEZ\b/i.test(`${customer.address || ''} ${customer.company || ''}`);

  const payload = {
    customer_id: contactId,
    invoice_number: inv.invoice_no,
    date: inv.invoice_date,
    due_date: inv.due_date || undefined,
    line_items: lineItems,
    gst_treatment: isSEZ ? 'sez_wp' : (gstin ? 'business_gst' : 'consumer'),
    gst_no: gstin || undefined,
    place_of_supply: stateCodeOf(customer.state)
  };

  const existing = inv.zoho_invoice_id;
  const result = existing
    ? await zohoRequest('PUT', `/invoices/${existing}`, payload)
    : await zohoRequest('POST', '/invoices', payload);

  const newInvoiceId = result.invoice.invoice_id;
  await run('UPDATE invoices SET zoho_invoice_id = ? WHERE id = ?', [newInvoiceId, inv.id]);

  await run(
    `INSERT INTO zoho_sync_logs (entity_type, entity_id, zoho_id, status, message)
     VALUES ('Invoice', ?, ?, 'Success', ?)`,
    [inv.id, newInvoiceId, `Synced to Zoho Invoice ${inv.invoice_no}`]
  );

  return { invoice_id: newInvoiceId, invoice_number: inv.invoice_no };
}

// 7. Check Connection & Status
async function checkZohoConnection() {
  try {
    const orgId = process.env.ZOHO_ORGANIZATION_ID;
    const token = await getAccessToken();
    const org = await zohoRequest('GET', `/organizations/${orgId}`);
    return {
      connected: true,
      org_id: orgId,
      org_name: org.organization?.name || 'Ramraj Enterprises',
      dc: ZOHO_DC,
      access_token_preview: token ? token.substring(0, 10) + '...' : null
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      org_id: process.env.ZOHO_ORGANIZATION_ID || null,
      dc: ZOHO_DC
    };
  }
}

module.exports = {
  checkZohoConnection,
  findOrCreateContact,
  findOrCreateItem,
  pushQuotationToZoho,
  pushInvoiceToZoho,
  zohoRequest
};
