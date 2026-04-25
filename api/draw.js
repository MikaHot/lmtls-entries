// api/draw.js — LMTLS Draw Admin API v5
import { createClient } from '@supabase/supabase-js';
import * as OTPAuth from 'otpauth';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DRAW_PASSWORD = process.env.DRAW_PASSWORD;
const TOTP_SECRET   = process.env.TOTP_SECRET;
const FREE_ENTRIES  = parseInt(process.env.FREE_SIGNUP_ENTRIES || '15');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TOTP-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const auth     = (req.headers['authorization'] || '').replace('Bearer ', '');
  const totpCode = (req.headers['x-totp-code'] || '').trim();

  if (auth !== DRAW_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') {
    if (!totpCode) return res.status(401).json({ error: 'Authenticator code required', totp_required: true });
    try {
      const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(TOTP_SECRET), digits: 6, period: 30 });
      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) return res.status(401).json({ error: 'Invalid authenticator code', totp_required: true });
    } catch { return res.status(401).json({ error: 'TOTP error', totp_required: true }); }
  }

  try {
    if (action === 'stats')             return await handleStats(res);
    if (action === 'participants')      return await handleParticipants(req, res);
    if (action === 'draw')              return await handleDraw(req, res);
    if (action === 'history')           return await handleHistory(res);
    if (action === 'delete-giveaway')   return await handleDeleteGiveaway(req, res);
    if (action === 'new-giveaway')      return await handleNewGiveaway(req, res);
    if (action === 'active-giveaway')   return await handleActiveGiveaway(res);
    if (action === 'totp-qr')           return await handleTOTPQR(res);
    if (action === 'revenue')           return await handleRevenue(req, res);
    if (action === 'export-csv')        return await handleExportCSV(req, res);
    if (action === 'delete-transaction')return await handleDeleteTransaction(req, res);
    if (action === 'transactions')      return await handleTransactions(req, res);
    if (action === 'grant-entries')     return await handleGrantEntries(req, res);
    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleTOTPQR(res) {
  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') return res.status(200).json({ already_configured: true });
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp   = new OTPAuth.TOTP({ issuer: 'LMTLS Draw', label: 'LMTLS Admin', secret, digits: 6, period: 30 });
  return res.status(200).json({ secret_base32: secret.base32, otpauth_url: totp.toString() });
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
  const totalEntries = all.reduce((s,e) => s + e.total_entries, 0);
  return res.status(200).json({
    giveaway,
    total_participants:     all.length,
    total_entries:          totalEntries,
    total_paid_entries:     all.reduce((s,e) => s + e.paid_entries,  0),
    total_free_entries:     all.reduce((s,e) => s + e.free_entries,  0),
    free_only_participants: all.filter(e => e.paid_entries === 0).length,
    top_10:                 all.slice(0, 10),
    totp_configured:        !!(TOTP_SECRET && TOTP_SECRET !== 'DISABLED'),
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
  const winProb    = ((winner.total_entries / total) * 100).toFixed(2);

  await supabase.from('entries_log').insert({
    email: winner.email, event_type: 'draw_win', entries_awarded: 0, giveaway_id: giveaway.id,
    note: `WINNER — ${giveaway.name} — ${winnerName} (${winner.email}) — ${winner.total_entries} entries / ${total} total (${winProb}%) — ${entries.length} participants`,
  });

  await supabase.from('giveaway_participants').insert(
    entries.map(e => ({ giveaway_id: giveaway.id, email: e.email, first_name: e.first_name, last_name: e.last_name, phone: e.phone, entries: e.total_entries, won: e.email === winner.email }))
  );

  await supabase.from('giveaways').update({
    winner_email: winner.email, winner_name: winnerName, winner_phone: winner.phone,
    total_participants: entries.length, total_entries: total,
  }).eq('id', giveaway.id);

  return res.status(200).json({
    winner: {
      name: winnerName, email: winner.email,
      phone: winner.phone || 'Not provided',
      entries: winner.total_entries,
      win_probability: winProb,
    },
    draw_stats: {
      giveaway_name: giveaway.name,
      total_participants: entries.length,
      total_entries: total,
    },
    drawn_at: new Date().toISOString(),
  });
}

async function handleHistory(res) {
  const { data: giveaways } = await supabase.from('giveaways').select('*').order('created_at', { ascending: false });
  const { data: draws }     = await supabase.from('entries_log').select('id,email,note,created_at,giveaway_id').eq('event_type','draw_win').order('created_at', { ascending: false });
  return res.status(200).json({ giveaways: giveaways||[], draws: draws||[] });
}

async function handleDeleteGiveaway(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const { giveaway_id } = req.body || {};
  if (!giveaway_id) return res.status(400).json({ error: 'giveaway_id required' });

  await supabase.from('entries').update({ current_giveaway_id: null }).eq('current_giveaway_id', giveaway_id);
  await supabase.from('entries_log').update({ giveaway_id: null }).eq('giveaway_id', giveaway_id);
  await supabase.from('giveaway_participants').delete().eq('giveaway_id', giveaway_id);
  const { error } = await supabase.from('giveaways').delete().eq('id', giveaway_id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ deleted: true });
}

// New giveaway — lazy free entries (granted on login, not immediately)
async function handleNewGiveaway(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { name, is_test } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Giveaway name required' });

  // Mark current giveaway completed
  await supabase.from('giveaways').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('status', 'active');

  // Create new giveaway — is_test flag for test giveaways
  const { data: ng } = await supabase.from('giveaways')
    .insert({ name, status: 'active', is_test: !!is_test })
    .select().single();

  // Reset entries to 0 — free entries will be granted lazily on login
  const { data: all } = await supabase.from('entries').select('email,alltime_entries,total_entries');
  if (all?.length) {
    for (const e of all) {
      await supabase.from('entries').update({
        total_entries: 0, free_entries: 0, paid_entries: 0,
        alltime_entries: (e.alltime_entries||0) + e.total_entries,
        current_giveaway_id: ng.id,
        free_entries_claimed: false, // new flag — not claimed yet
      }).eq('email', e.email);
    }
  }
  return res.status(200).json({ giveaway: ng, participants_reset: all?.length || 0, message: 'Free entries will be granted when participants log in' });
}

async function handleActiveGiveaway(res) {
  return res.status(200).json({ giveaway: await getActiveGiveaway() });
}

// Grant free entries on login (called by get-entries.js when user has 0 entries)
async function handleGrantEntries(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  const giveaway = await getActiveGiveaway();
  if (!giveaway) return res.status(200).json({ granted: false, reason: 'No active giveaway' });

  const { data: participant } = await supabase.from('entries').select('total_entries,free_entries_claimed').eq('email', email).single();
  if (!participant) return res.status(200).json({ granted: false, reason: 'Participant not found' });

  // Only grant if not claimed yet for this giveaway and they have 0 entries
  if (participant.free_entries_claimed) return res.status(200).json({ granted: false, reason: 'Already claimed' });

  await supabase.from('entries').update({
    total_entries: FREE_ENTRIES,
    free_entries: FREE_ENTRIES,
    free_entries_claimed: true,
  }).eq('email', email);

  await supabase.from('entries_log').insert({
    email, event_type: 'signup', entries_awarded: FREE_ENTRIES,
    giveaway_id: giveaway.id,
    note: `Free entries claimed on login — ${giveaway.name}`,
  });

  return res.status(200).json({ granted: true, entries_awarded: FREE_ENTRIES });
}

async function handleRevenue(req, res) {
  const period = req.query.period || '30';
  const since  = new Date();
  since.setDate(since.getDate() - parseInt(period));

  const { data: logs } = await supabase.from('entries_log')
    .select('id,email,order_amount,entries_awarded,created_at,giveaway_id,note')
    .eq('event_type', 'purchase')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (!logs) return res.status(500).json({ error: 'DB error' });

  const dailyMap = {};
  let totalRevenue = 0, totalOrders = 0;
  logs.forEach(l => {
    const amount = parseFloat(l.order_amount || 0);
    const day    = l.created_at.slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { date: day, revenue: 0, orders: 0, entries: 0 };
    dailyMap[day].revenue  += amount;
    dailyMap[day].orders   += 1;
    dailyMap[day].entries  += l.entries_awarded || 0;
    totalRevenue += amount;
    totalOrders  += 1;
  });

  const daily = Object.values(dailyMap).sort((a,b) => a.date.localeCompare(b.date));

  const { data: giveaways } = await supabase.from('giveaways').select('id,name');
  const gMap = {};
  if (giveaways) giveaways.forEach(g => { gMap[g.id] = g.name; });

  const byGiveaway = {};
  logs.forEach(l => {
    const gid = l.giveaway_id || 'unknown';
    if (!byGiveaway[gid]) byGiveaway[gid] = { name: gMap[gid]||'Unknown', revenue: 0, orders: 0 };
    byGiveaway[gid].revenue += parseFloat(l.order_amount||0);
    byGiveaway[gid].orders  += 1;
  });

  const { data: allLogs } = await supabase.from('entries_log').select('order_amount').eq('event_type','purchase');
  const allTimeRevenue = (allLogs||[]).reduce((s,l) => s + parseFloat(l.order_amount||0), 0);

  return res.status(200).json({
    period_days: parseInt(period), period_revenue: Math.round(totalRevenue*100)/100,
    period_orders: totalOrders, avg_order: totalOrders>0 ? Math.round((totalRevenue/totalOrders)*100)/100 : 0,
    alltime_revenue: Math.round(allTimeRevenue*100)/100, alltime_orders: allLogs?.length||0,
    daily, by_giveaway: Object.values(byGiveaway),
    transactions: logs.slice(0,50), // most recent 50 transactions
  });
}

// List individual transactions
async function handleTransactions(req, res) {
  const page  = parseInt(req.query.page||'1');
  const limit = 25;
  const from  = (page-1)*limit;

  const { data, count, error } = await supabase.from('entries_log')
    .select('id,email,order_amount,entries_awarded,created_at,note', { count:'exact' })
    .eq('event_type','purchase')
    .order('created_at', { ascending: false })
    .range(from, from+limit-1);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ transactions: data||[], total: count, page, pages: Math.ceil(count/limit) });
}

// Delete a specific transaction log entry (for erroneous transactions)
async function handleDeleteTransaction(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const { log_id, email, entries_to_remove } = req.body || {};
  if (!log_id) return res.status(400).json({ error: 'log_id required' });

  // Remove entries from participant
  if (email && entries_to_remove > 0) {
    const { data: participant } = await supabase.from('entries').select('total_entries,paid_entries').eq('email',email).single();
    if (participant) {
      await supabase.from('entries').update({
        total_entries: Math.max(0, participant.total_entries - entries_to_remove),
        paid_entries:  Math.max(0, participant.paid_entries  - entries_to_remove),
      }).eq('email', email);
    }
  }

  // Delete the log entry
  const { error } = await supabase.from('entries_log').delete().eq('id', log_id).eq('event_type','purchase');
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ deleted: true });
}

async function handleExportCSV(req, res) {
  const type = req.query.type || 'all';
  let query = supabase.from('entries')
    .select('email,first_name,last_name,phone,total_entries,free_entries,paid_entries,alltime_entries,created_at')
    .order('total_entries', { ascending: false });
  if (type === 'buyers')    query = query.gt('paid_entries', 0);
  if (type === 'free_only') query = query.eq('paid_entries', 0);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const headers = ['Email','First Name','Last Name','Phone','Current Entries','Free Entries','Paid Entries','All-time Entries','Member Since'];
  const rows = (data||[]).map(p => [
    p.email, p.first_name||'', p.last_name||'', p.phone||'',
    p.total_entries, p.free_entries, p.paid_entries, p.alltime_entries||0,
    new Date(p.created_at).toLocaleDateString('en-CA'),
  ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="lmtls-${type}-${new Date().toISOString().slice(0,10)}.csv"`);
  return res.status(200).send(csv);
}
