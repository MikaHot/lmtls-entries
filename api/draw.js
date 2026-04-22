// api/draw.js
// Effectue le tirage au sort et retourne le gagnant

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth simple par mot de passe
  const auth = req.headers['authorization'] || '';
  const password = auth.replace('Bearer ', '');
  if (password !== process.env.DRAW_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET' && req.query.action === 'stats') {
    return handleStats(res);
  }

  if (req.method === 'POST' && req.query.action === 'draw') {
    return handleDraw(req, res);
  }

  if (req.method === 'GET' && req.query.action === 'history') {
    return handleHistory(res);
  }

  return res.status(400).json({ error: 'Invalid action' });
}

// Stats générales
async function handleStats(res) {
  const { data: entries } = await supabase
    .from('entries')
    .select('email, first_name, last_name, total_entries, paid_entries, free_entries')
    .order('total_entries', { ascending: false });

  if (!entries) return res.status(500).json({ error: 'Failed to fetch entries' });

  const totalParticipants = entries.length;
  const totalEntries = entries.reduce((sum, e) => sum + e.total_entries, 0);
  const totalPaid = entries.reduce((sum, e) => sum + e.paid_entries, 0);

  return res.status(200).json({
    total_participants: totalParticipants,
    total_entries: totalEntries,
    total_paid_entries: totalPaid,
    top_10: entries.slice(0, 10),
  });
}

// Effectue le tirage
async function handleDraw(req, res) {
  const { giveaway_name } = req.body || {};

  // Récupère tous les participants avec entries > 0
  const { data: entries } = await supabase
    .from('entries')
    .select('email, first_name, last_name, total_entries')
    .gt('total_entries', 0);

  if (!entries || entries.length === 0) {
    return res.status(400).json({ error: 'No eligible participants' });
  }

  // Construit le pool de tirage (1 ticket par entry)
  // Pour éviter un array massif, on utilise une méthode pondérée
  const totalEntries = entries.reduce((sum, e) => sum + e.total_entries, 0);
  
  // Tire un nombre aléatoire entre 0 et totalEntries
  let random = Math.floor(Math.random() * totalEntries);
  
  let winner = null;
  for (const participant of entries) {
    random -= participant.total_entries;
    if (random < 0) {
      winner = participant;
      break;
    }
  }

  if (!winner) winner = entries[entries.length - 1];

  // Enregistre le tirage dans les logs
  await supabase.from('entries_log').insert({
    email: winner.email,
    event_type: 'draw_win',
    entries_awarded: 0,
    note: `WINNER — ${giveaway_name || 'Giveaway'} — Draw from ${totalEntries} total entries across ${entries.length} participants`,
  });

  return res.status(200).json({
    winner: {
      email: winner.email,
      first_name: winner.first_name,
      last_name: winner.last_name,
      entries: winner.total_entries,
    },
    draw_stats: {
      total_participants: entries.length,
      total_entries: totalEntries,
      win_probability: ((winner.total_entries / totalEntries) * 100).toFixed(2),
    },
    drawn_at: new Date().toISOString(),
  });
}

// Historique des tirages
async function handleHistory(res) {
  const { data: logs } = await supabase
    .from('entries_log')
    .select('email, note, created_at')
    .eq('event_type', 'draw_win')
    .order('created_at', { ascending: false });

  return res.status(200).json({ history: logs || [] });
}
