// api/get-entries.js
// Retourne le total d'entries pour un email donné
// Appelé par le dashboard client sur Shopify

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS — permet à Shopify d'appeler cette API
  res.setHeader('Access-Control-Allow-Origin', process.env.SHOPIFY_STORE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const cleanEmail = decodeURIComponent(email).toLowerCase().trim();

  // Récupère les entries du client
  const { data, error } = await supabase
    .from('entries')
    .select('email, first_name, total_entries, free_entries, paid_entries, created_at')
    .eq('email', cleanEmail)
    .single();

  if (error || !data) {
    return res.status(200).json({
      found: false,
      total_entries: 0,
      message: 'No entries found for this email'
    });
  }

  // Récupère les 10 derniers événements
  const { data: logs } = await supabase
    .from('entries_log')
    .select('event_type, entries_awarded, order_amount, note, created_at')
    .eq('email', cleanEmail)
    .order('created_at', { ascending: false })
    .limit(10);

  return res.status(200).json({
    found:         true,
    first_name:    data.first_name,
    total_entries: data.total_entries,
    free_entries:  data.free_entries,
    paid_entries:  data.paid_entries,
    member_since:  data.created_at,
    recent_activity: logs || [],
  });
}
