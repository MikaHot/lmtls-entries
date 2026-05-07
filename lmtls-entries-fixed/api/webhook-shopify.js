// api/webhook-shopify.js
// Reçoit les webhooks Shopify et crédite les entries

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ENTRIES_PER_DOLLAR    = parseInt(process.env.ENTRIES_PER_DOLLAR    || '10');
const FREE_SIGNUP_ENTRIES   = parseInt(process.env.FREE_SIGNUP_ENTRIES   || '15');
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Entry Pass variant → pass info mapping
const VARIANT_PASS_MAP = {
  '52970826989890': { name: 'Bronze',   entries: 600  },
  '52972490162498': { name: 'Silver',   entries: 1800 },
  '52976338731330': { name: 'Gold',     entries: null }, // null = $ calc
  '52976346333506': { name: 'Platinum', entries: null },
};

function verifyShopifyWebhook(body, hmacHeader) {
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('base64');
  return hash === hmacHeader;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const topic = req.headers['x-shopify-topic'];
  const hmac  = req.headers['x-shopify-hmac-sha256'];

  const rawBody = await getRawBody(req);

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.error('Invalid Shopify webhook signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = JSON.parse(rawBody);

  try {
    if (topic === 'customers/create')  await handleNewCustomer(data);
    else if (topic === 'orders/paid')      await handleOrderPaid(data);
    else if (topic === 'orders/cancelled') await handleOrderCancelled(data);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Nouveau client → free entries
async function handleNewCustomer(customer) {
  const email      = customer.email?.toLowerCase();
  const first_name = customer.first_name || '';
  const last_name  = customer.last_name  || '';
  if (!email) return;

  const { data: existing } = await supabase
    .from('entries').select('id').eq('email', email).single();
  if (existing) return;

  await supabase.from('entries').insert({
    email, first_name, last_name,
    total_entries: FREE_SIGNUP_ENTRIES,
    free_entries:  FREE_SIGNUP_ENTRIES,
    paid_entries:  0,
  });

  await supabase.from('entries_log').insert({
    email, event_type: 'signup',
    entries_awarded: FREE_SIGNUP_ENTRIES,
    note: 'Free entries on account creation',
  });

  console.log(`New customer ${email} → +${FREE_SIGNUP_ENTRIES} free entries`);
}

// Commande payée → un log par variant Entry Pass
async function handleOrderPaid(order) {
  const email    = order.email?.toLowerCase();
  const order_id = String(order.id);
  if (!email) return;

  // Déduplique
  const { data: existing } = await supabase
    .from('entries_log').select('id')
    .eq('order_id', order_id).eq('event_type', 'purchase').limit(1).single();
  if (existing) { console.log('Order already processed:', order_id); return; }

  // Giveaway actif
  const { data: giveaway } = await supabase
    .from('giveaways').select('id,name').eq('status','active').limit(1).single();

  const line_items = order.line_items || [];
  let total_entries_awarded = 0;
  const logs = [];

  for (const item of line_items) {
    const variant_id = String(item.variant_id || '');
    const qty        = item.quantity || 1;
    const item_price = parseFloat(item.price || 0) * qty;
    const pass       = VARIANT_PASS_MAP[variant_id];

    let entries_awarded, pass_type, pass_label;

    if (pass) {
      entries_awarded = (pass.entries !== null)
        ? pass.entries * qty
        : Math.floor(item_price * ENTRIES_PER_DOLLAR);
      pass_type  = pass.name.toLowerCase();
      pass_label = `Entry Pass — ${pass.name}`;
    } else {
      entries_awarded = Math.floor(item_price * ENTRIES_PER_DOLLAR);
      pass_type  = 'other';
      pass_label = item.title || 'Product';
    }

    if (entries_awarded <= 0) continue;
    total_entries_awarded += entries_awarded;

    logs.push({
      email,
      event_type:      'purchase',
      entries_awarded,
      order_id,
      order_amount:    item_price,
      giveaway_id:     giveaway?.id || null,
      variant_id,
      pass_type,
      note: `Order #${order.order_number} — ${pass_label} × ${qty} — $${item_price.toFixed(2)} — +${entries_awarded} entries`,
    });
  }

  if (total_entries_awarded <= 0) return;

  // Upsert participant
  const { data: customer } = await supabase
    .from('entries').select('id,total_entries,paid_entries')
    .eq('email', email).single();

  if (customer) {
    await supabase.from('entries').update({
      total_entries: customer.total_entries + total_entries_awarded,
      paid_entries:  customer.paid_entries  + total_entries_awarded,
    }).eq('email', email);
  } else {
    const firstName = order.billing_address?.first_name || order.customer?.first_name || '';
    const lastName  = order.billing_address?.last_name  || order.customer?.last_name  || '';
    await supabase.from('entries').insert({
      email, first_name: firstName, last_name: lastName,
      total_entries: total_entries_awarded,
      free_entries:  0,
      paid_entries:  total_entries_awarded,
    });
  }

  if (logs.length > 0) await supabase.from('entries_log').insert(logs);

  console.log(`Order ${order_id} (${email}) → +${total_entries_awarded} entries (${logs.length} line items)`);
}

// Commande annulée → retire toutes les entries de cette commande
async function handleOrderCancelled(order) {
  const email    = order.email?.toLowerCase();
  const order_id = String(order.id);
  if (!email) return;

  const { data: logs } = await supabase
    .from('entries_log').select('entries_awarded')
    .eq('order_id', order_id).eq('event_type', 'purchase');

  if (!logs?.length) { console.log('No entries for cancelled order:', order_id); return; }

  const to_remove = logs.reduce((s, l) => s + (l.entries_awarded || 0), 0);

  const { data: customer } = await supabase
    .from('entries').select('total_entries,paid_entries').eq('email', email).single();

  if (customer) {
    await supabase.from('entries').update({
      total_entries: Math.max(0, customer.total_entries - to_remove),
      paid_entries:  Math.max(0, customer.paid_entries  - to_remove),
    }).eq('email', email);
  }

  await supabase.from('entries_log').insert({
    email, event_type: 'cancellation',
    entries_awarded: -to_remove, order_id,
    note: `Order #${order.order_number} cancelled — -${to_remove} entries removed`,
  });

  // Supprime les logs purchase de cette commande (retire du revenue aussi)
  await supabase.from('entries_log').delete()
    .eq('order_id', order_id).eq('event_type', 'purchase');

  console.log(`Order ${order_id} cancelled (${email}) → -${to_remove} entries`);
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

export const config = {
  api: { bodyParser: false },
};
