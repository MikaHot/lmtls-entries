// api/draw.js — LMTLS Draw Admin API v3
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DRAW_PASSWORD = process.env.DRAW_PASSWORD;
const TOTP_SECRET   = process.env.TOTP_SECRET; // base32 — set via Vercel env only
const FREE_ENTRIES  = parseInt(process.env.FREE_SIGNUP_ENTRIES || '15');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TOTP-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  // Auth — always required, no public endpoints
  const auth     = (req.headers['authorization'] || '').replace('Bearer ', '');
  const totpCode = (req.headers['x-totp-code'] || '').trim();

  if (auth !== DRAW_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  // TOTP — required if configured and not 'DISABLED'
  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') {
    if (!totpCode) {
      return res.status(401).json({ error: 'Authenticator code required', totp_required: true });
    }
    try {
      const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(TOTP_SECRET), digits: 6, period: 30 });
      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid authenticator code', totp_required: true });
      }
    } catch (e) {
      return res.status(401).json({ error: 'TOTP configuration error', totp_required: true });
    }
  }

  try {
    if (action === 'stats')           return await handleStats(res);
    if (action === 'participants')    return await handleParticipants(req, res);
    if (action === 'draw')            return await handleDraw(req, res);
    if (action === 'history')         return await handleHistory(res);
    if (action === 'delete-giveaway') return await handleDeleteGiveaway(req, res);
    if (action === 'new-giveaway')    return await handleNewGiveaway(req, res);
    if (action === 'active-giveaway') return await handleActiveGiveaway(res);
    if (action === 'totp-qr')         return await handleTOTPQR(res);
    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── TOTP QR — authenticated, one-time setup helper ──
async function handleTOTPQR(res) {
  // Returns QR data only if TOTP is not yet configured
  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') {
    return res.status(200).json({ already_configured: true, message: 'TOTP is already active. To reconfigure, update TOTP_SECRET in Vercel env.' });
  }
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp   = new OTPAuth.TOTP({ issuer: 'LMTLS Draw', label: 'LMTLS Admin', secret, digits: 6, period: 30 });
  return res.status(200).json({
    secret_base32: secret.base32,
    otpauth_url: totp.toString(),
    next_step: 'Add TOTP_SECRET=' + secret.base32 + ' in Vercel Environment Variables, then redeploy.'
  });
}

async function getActiveGiveaway() {
  const { data } = await supabase.from('giveaways').select('*').eq('status', 'active').limit(1).single();
  return data;
}

async function handleStats(res) {
  const giveaway = await getActiveGiveaway();
  const { data: all } = await supabase.from('entries')
    .select('email,first_name,last_name,phone,total_entries,free_entries,paid_entries,alltime_entries')
    .order('total_entries', { ascending: false });
  if (!all) return res.status(500).json({ error: 'DB error' });
  return res.status(200).json({
    giveaway,
    total_participants:     all.length,
    total_entries:          all.reduce((s,e) => s + e.total_entries, 0),
    total_paid_entries:     all.reduce((s,e) => s + e.paid_entries,  0),
    total_free_entries:     all.reduce((s,e) => s + e.free_entries,  0),
    free_only_participants: all.filter(e => e.paid_entries === 0).length,
    top_10:                 all.slice(0, 10),
  });
}

async function handleParticipants(req, res) {
  const page   = parseInt(req.query.page   || '1');
  const limit  = parseInt(req.query.limit  || '50');
  const search = req.query.search || '';
  const filter = req.query.filter || 'all';

  let query = supabase.from('entries')
    .select('email,first_name,last_name,phone,total_entries,free_entries,paid_entries,alltime_entries,created_at', { count: 'exact' });

  if (search) query = query.or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%,phone.ilike.%${search}%`);
  if (filter === 'free_only') query = query.eq('paid_entries', 0);
  if (filter === 'paid')      query = query.gt('paid_entries', 0);

  const from = (page-1)*limit;
  const { data, count, error } = await query.order('total_entries', { ascending: false }).range(from, from+limit-1);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ participants: data, total: count, page, pages: Math.ceil(count/limit) });
}

async function handleDraw(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const giveaway = await getActiveGiveaway();
  if (!giveaway) return res.status(400).json({ error: 'No active giveaway' });

  const { data: entries } = await supabase.from('entries')
    .select('email,first_name,last_name,phone,total_entries').gt('total_entries', 0);
  if (!entries?.length) return res.status(400).json({ error: 'No eligible participants' });

  const total = entries.reduce((s,e) => s + e.total_entries, 0);
  let rand    = Math.floor(Math.random() * total);
  let winner  = entries[entries.length-1];
  for (const p of entries) { rand -= p.total_entries; if (rand < 0) { winner = p; break; } }

  const winnerName = `${winner.first_name||''} ${winner.last_name||''}`.trim();

  await supabase.from('entries_log').insert({
    email: winner.email, event_type: 'draw_win', entries_awarded: 0, giveaway_id: giveaway.id,
    note: `WINNER — ${giveaway.name} — ${winnerName} (${winner.email}) — ${winner.total_entries} entries / ${total} total / ${entries.length} participants`,
  });

  await supabase.from('giveaway_participants').insert(
    entries.map(e => ({ giveaway_id: giveaway.id, email: e.email, first_name: e.first_name, last_name: e.last_name, phone: e.phone, entries: e.total_entries, won: e.email === winner.email }))
  );

  await supabase.from('giveaways').update({
    winner_email: winner.email, winner_name: winnerName, winner_phone: winner.phone,
    total_participants: entries.length, total_entries: total,
  }).eq('id', giveaway.id);

  return res.status(200).json({
    winner: { name: winnerName, email: winner.email, phone: winner.phone || 'Not provided', entries: winner.total_entries },
    draw_stats: { giveaway_name: giveaway.name, total_participants: entries.length, total_entries: total, win_probability: ((winner.total_entries/total)*100).toFixed(2) },
    drawn_at: new Date().toISOString(),
  });
}

async function handleHistory(res) {
  const { data: giveaways } = await supabase.from('giveaways').select('*').order('created_at', { ascending: false });
  const { data: draws }     = await supabase.from('entries_log').select('id,email,note,created_at,giveaway_id').eq('event_type','draw_win').order('created_at', { ascending: false });
  return res.status(200).json({ giveaways: giveaways||[], draws: draws||[] });
}

// Delete a giveaway AND its draw log entry
async function handleDeleteGiveaway(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const { giveaway_id } = req.body || {};
  if (!giveaway_id) return res.status(400).json({ error: 'giveaway_id required' });

  // Nullify ALL foreign key references before deleting
  await supabase.from('entries')
    .update({ current_giveaway_id: null })
    .eq('current_giveaway_id', giveaway_id);

  await supabase.from('entries_log')
    .update({ giveaway_id: null })
    .eq('giveaway_id', giveaway_id);

  await supabase.from('giveaway_participants').delete()
    .eq('giveaway_id', giveaway_id);

  const { error } = await supabase.from('giveaways').delete()
    .eq('id', giveaway_id);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ deleted: true });
}

async function handleNewGiveaway(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Giveaway name required' });

  await supabase.from('giveaways').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('status', 'active');
  const { data: ng } = await supabase.from('giveaways').insert({ name, status: 'active' }).select().single();

  const { data: all } = await supabase.from('entries').select('email,alltime_entries,total_entries');
  if (all?.length) {
    for (const e of all) {
      await supabase.from('entries').update({
        total_entries: FREE_ENTRIES, free_entries: FREE_ENTRIES, paid_entries: 0,
        alltime_entries: (e.alltime_entries||0) + e.total_entries,
        current_giveaway_id: ng.id,
      }).eq('email', e.email);
      await supabase.from('entries_log').insert({ email: e.email, event_type: 'signup', entries_awarded: FREE_ENTRIES, giveaway_id: ng.id, note: `Fresh free entries — ${name}` });
    }
  }
  return res.status(200).json({ giveaway: ng, participants_reset: all?.length || 0, free_entries_granted: FREE_ENTRIES });
}

async function handleActiveGiveaway(res) {
  const g = await getActiveGiveaway();
  return res.status(200).json({ giveaway: g });
}
