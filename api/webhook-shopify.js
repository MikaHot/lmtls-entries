// api/webhook-shopify.js
// Reçoit les webhooks Shopify et crédite les entries

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ENTRIES_PER_DOLLAR = parseInt(process.env.ENTRIES_PER_DOLLAR || '10');
const FREE_SIGNUP_ENTRIES = parseInt(process.env.FREE_SIGNUP_ENTRIES || '15');
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Vérifie que le webhook vient vraiment de Shopify
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

  // Lire le body raw pour vérifier la signature
  const rawBody = await getRawBody(req);

  if (!verifyShopifyWebhook(rawBody, hmac)) {
    console.error('Invalid Shopify webhook signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = JSON.parse(rawBody);

  try {
    if (topic === 'customers/create') {
      await handleNewCustomer(data);
    } else if (topic === 'orders/paid') {
      await handleOrderPaid(data);
    }
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

  // Vérifie si déjà inscrit
  const { data: existing } = await supabase
    .from('entries')
    .select('id, total_entries')
    .eq('email', email)
    .single();

  if (existing) {
    console.log('Customer already exists:', email);
    return;
  }

  // Crée le client avec ses free entries
  const { error } = await supabase.from('entries').insert({
    email,
    first_name,
    last_name,
    total_entries: FREE_SIGNUP_ENTRIES,
    free_entries:  FREE_SIGNUP_ENTRIES,
    paid_entries:  0,
  });

  if (error) throw error;

  // Log l'événement
  await supabase.from('entries_log').insert({
    email,
    event_type:      'signup',
    entries_awarded: FREE_SIGNUP_ENTRIES,
    note:            'Free entries on account creation',
  });

  console.log(`New customer ${email} → +${FREE_SIGNUP_ENTRIES} free entries`);
}

// Commande payée → paid entries basés sur le montant
async function handleOrderPaid(order) {
  const email      = order.email?.toLowerCase();
  const order_id   = String(order.id);
  const order_amount = parseFloat(order.subtotal_price || 0); // avant taxes

  if (!email) return;

  // Vérifie que cette commande n'a pas déjà été traitée
  const { data: existing } = await supabase
    .from('entries_log')
    .select('id')
    .eq('order_id', order_id)
    .single();

  if (existing) {
    console.log('Order already processed:', order_id);
    return;
  }

  const entries_awarded = Math.floor(order_amount * ENTRIES_PER_DOLLAR);
  if (entries_awarded <= 0) return;

  // Upsert le client (cas où il commande sans créer de compte)
  const { data: customer } = await supabase
    .from('entries')
    .select('id, total_entries, paid_entries, first_name')
    .eq('email', email)
    .single();

  if (customer) {
    // Client existant — on ajoute
    await supabase
      .from('entries')
      .update({
        total_entries: customer.total_entries + entries_awarded,
        paid_entries:  customer.paid_entries  + entries_awarded,
      })
      .eq('email', email);
  } else {
    // Nouveau client sans compte — on crée
    const firstName = order.billing_address?.first_name || order.customer?.first_name || '';
    const lastName  = order.billing_address?.last_name  || order.customer?.last_name  || '';
    await supabase.from('entries').insert({
      email,
      first_name:    firstName,
      last_name:     lastName,
      total_entries: entries_awarded,
      free_entries:  0,
      paid_entries:  entries_awarded,
    });
  }

  // Log la commande
  await supabase.from('entries_log').insert({
    email,
    event_type:      'purchase',
    entries_awarded,
    order_id,
    order_amount,
    note: `Order #${order.order_number} — $${order_amount} × ${ENTRIES_PER_DOLLAR} entries/$`,
  });

  console.log(`Order ${order_id} (${email}) → +${entries_awarded} entries ($${order_amount})`);
}

// Helper pour lire le body en raw (nécessaire pour vérifier la signature Shopify)
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

export const config = {
  api: { bodyParser: false }, // Important — ne pas parser le body automatiquement
};
