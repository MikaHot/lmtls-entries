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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-TOTP-Code, X-Session-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;
  const auth         = (req.headers['authorization'] || '').replace('Bearer ', '');
  const sessionTok   = req.headers['x-session-token'] || '';
  const totpCode = (req.headers['x-totp-code'] || '').trim();

  if (auth !== DRAW_PASSWORD) return res.status(401).json({ error: 'Invalid password' });

  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') {
    const sessionToken = req.headers['x-session-token'] || '';
    // Accept valid session token (avoids re-entering TOTP every call)
    if (sessionToken && sessionToken === process.env.DRAW_PASSWORD + '_session_' + Math.floor(Date.now() / (4*3600*1000))) {
      // Valid session (expires at end of current hour)
    } else {
      if (!totpCode) return res.status(401).json({ error: 'Authenticator code required', totp_required: true });
      try {
        const totp  = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(TOTP_SECRET), digits: 6, period: 30 });
        const delta = totp.validate({ token: totpCode, window: 10 });
        if (delta === null) return res.status(401).json({ error: 'Invalid authenticator code', totp_required: true });
      } catch { return res.status(401).json({ error: 'TOTP error', totp_required: true }); }
    }
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
    if (action === 'debug-orders')       return await handleDebugOrders(req, res);
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
  // If already configured — return the EXISTING secret QR so user can add another device
  if (TOTP_SECRET && TOTP_SECRET !== 'DISABLED') {
    const otpauth_url = 'otpauth://totp/LMTLS%20Draw%3Aadmin%40lmtlsperformance.ca?secret=' + TOTP_SECRET + '&issuer=LMTLS%20Draw&algorithm=SHA1&digits=6&period=30';
    return res.status(200).json({
      already_configured: true,
      existing_secret: TOTP_SECRET,
      existing_otpauth_url: otpauth_url,
      // Also populate standard fields so the same QR display code works
      secret_base32: TOTP_SECRET,
      otpauth_url,
    });
  }
  // First-time setup — generate new secret
  const secret = new OTPAuth.Secret({ size: 20 });
  const base32 = secret.base32;
  const otpauth_url = 'otpauth://totp/LMTLS%20Draw%3Aadmin%40lmtlsperformance.ca?secret=' + base32 + '&issuer=LMTLS%20Draw&algorithm=SHA1&digits=6&period=30';
  return res.status(200).json({ secret_base32: base32, otpauth_url });
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
    session_token:          process.env.DRAW_PASSWORD + '_session_' + Math.floor(Date.now() / (4*3600*1000)),
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
  const period  = parseInt(req.query.period || '30');
  const allTime = period === 0;

  // ── Fetch logs ──────────────────────────────────────────────────────
  let q = supabase.from('entries_log')
    .select('id,email,order_amount,entries_awarded,created_at,giveaway_id,pass_type,order_id')
    .eq('event_type', 'purchase')
    .order('created_at', { ascending: false });

  if (!allTime) {
    const since = new Date();
    since.setDate(since.getDate() - period);
    since.setHours(0, 0, 0, 0); // start of day to avoid timezone edge issues
    q = q.gte('created_at', since.toISOString());
  }

  const { data: logs, error } = await q;
  if (error || !logs) return res.status(500).json({ error: error?.message || 'DB error' });

  // Temp debug — remove once orders fixed
  console.log('[revenue debug] period:', period, 'allTime:', allTime, 'logs count:', logs.length,
    'sample order_ids:', logs.slice(0,3).map(l => l.order_id));

  // ── Aggregate ────────────────────────────────────────────────────────
  // Use plain objects as sets (key = order_id string) to avoid any runtime issues with Set
  const periodOrderMap = {};   // { order_id: true }
  const dailyMap       = {};   // { date: { revenue, entries, orderMap } }
  const byPassMap      = {
    bronze:   { name:'Bronze',   revenue:0, entries:0, orderMap:{} },
    silver:   { name:'Silver',   revenue:0, entries:0, orderMap:{} },
    gold:     { name:'Gold',     revenue:0, entries:0, orderMap:{} },
    platinum: { name:'Platinum', revenue:0, entries:0, orderMap:{} },
    other:    { name:'Other',    revenue:0, entries:0, orderMap:{} },
  };
  const byGiveawayMap = {};

  let totalRevenue = 0;

  logs.forEach(l => {
    const amount  = parseFloat(l.order_amount) || 0;
    const oid     = l.order_id ? String(l.order_id) : null;
    const day     = (l.created_at || '').slice(0, 10);
    const pt      = (l.pass_type  || 'other').toLowerCase();
    const gid     = l.giveaway_id || 'unknown';
    const entries = parseInt(l.entries_awarded) || 0;

    totalRevenue += amount;
    if (oid) periodOrderMap[oid] = true;

    // Daily
    if (!dailyMap[day]) dailyMap[day] = { date:day, revenue:0, entries:0, orderMap:{} };
    dailyMap[day].revenue += amount;
    dailyMap[day].entries += entries;
    if (oid) dailyMap[day].orderMap[oid] = true;

    // By pass
    const pk = byPassMap[pt] ? pt : 'other';
    byPassMap[pk].revenue += amount;
    byPassMap[pk].entries += entries;
    if (oid) byPassMap[pk].orderMap[oid] = true;

    // By giveaway
    if (!byGiveawayMap[gid]) {
      const { data: giveaways } = { data: null }; // resolved below
      byGiveawayMap[gid] = { gid, revenue:0, entries:0, orderMap:{} };
    }
    byGiveawayMap[gid].revenue += amount;
    byGiveawayMap[gid].entries += entries;
    if (oid) byGiveawayMap[gid].orderMap[oid] = true;
  });

  // Resolve giveaway names
  const { data: giveaways } = await supabase.from('giveaways').select('id,name');
  const gMap = {};
  if (giveaways) giveaways.forEach(g => { gMap[g.id] = g.name; });

  // Convert dailyMap
  const daily = Object.values(dailyMap).map(d => ({
    date: d.date, revenue: d.revenue, entries: d.entries,
    orders: Object.keys(d.orderMap).length,
  })).sort((a,b) => a.date.localeCompare(b.date));

  // Convert byPass
  const byPass = Object.values(byPassMap).map(p => ({
    name: p.name, revenue: Math.round(p.revenue*100)/100,
    orders: Object.keys(p.orderMap).length, entries: p.entries,
  }));

  // Convert byGiveaway
  const byGiveaway = Object.values(byGiveawayMap).map(g => ({
    name: gMap[g.gid] || 'Unknown',
    revenue: Math.round(g.revenue*100)/100,
    orders: Object.keys(g.orderMap).length,
    entries: g.entries,
    avg_order: Object.keys(g.orderMap).length > 0
      ? Math.round((g.revenue / Object.keys(g.orderMap).length)*100)/100 : 0,
  }));

  const totalOrders = Object.keys(periodOrderMap).length;

  // ── All-time query ───────────────────────────────────────────────────
  const { data: allLogs } = await supabase.from('entries_log')
    .select('order_amount,pass_type,entries_awarded,order_id')
    .eq('event_type', 'purchase');

  const allTimeOrderMap = {};
  const allTimeByPassMap = {
    bronze:   { name:'Bronze',   revenue:0, entries:0, orderMap:{} },
    silver:   { name:'Silver',   revenue:0, entries:0, orderMap:{} },
    gold:     { name:'Gold',     revenue:0, entries:0, orderMap:{} },
    platinum: { name:'Platinum', revenue:0, entries:0, orderMap:{} },
    other:    { name:'Other',    revenue:0, entries:0, orderMap:{} },
  };
  let allTimeRevenue = 0;

  (allLogs || []).forEach(l => {
    const amount  = parseFloat(l.order_amount) || 0;
    const oid     = l.order_id ? String(l.order_id) : null;
    const pt      = (l.pass_type || 'other').toLowerCase();
    const entries = parseInt(l.entries_awarded) || 0;
    allTimeRevenue += amount;
    if (oid) allTimeOrderMap[oid] = true;
    const pk = allTimeByPassMap[pt] ? pt : 'other';
    allTimeByPassMap[pk].revenue += amount;
    allTimeByPassMap[pk].entries += entries;
    if (oid) allTimeByPassMap[pk].orderMap[oid] = true;
  });

  const allTimeOrders = Object.keys(allTimeOrderMap).length;
  const allTimeByPass = Object.values(allTimeByPassMap).map(p => ({
    name: p.name, revenue: Math.round(p.revenue*100)/100,
    orders: Object.keys(p.orderMap).length, entries: p.entries,
  }));

  return res.status(200).json({
    _debug: { logs_count: logs.length, period, allTime,
      sample_order_ids: logs.slice(0,3).map(l=>l.order_id),
      period_order_map_keys: Object.keys(periodOrderMap).length },
    period_days:    period,
    period_revenue: Math.round(totalRevenue*100)/100,
    period_orders:  totalOrders,
    avg_order:      totalOrders > 0 ? Math.round((totalRevenue/totalOrders)*100)/100 : 0,
    alltime_revenue: Math.round(allTimeRevenue*100)/100,
    alltime_orders:  allTimeOrders,
    daily,
    by_giveaway: byGiveaway,
    by_pass:     byPass,
    alltime_by_pass: allTimeByPass,
    transactions: logs.slice(0, 50),
  });
}

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

async function handleDebugOrders(req, res) {
  const { data } = await supabase.from('entries_log')
    .select('id,order_id,pass_type,order_amount,event_type,created_at')
    .eq('event_type','purchase')
    .order('created_at', { ascending: false })
    .limit(20);
  return res.status(200).json({
    total_rows: data?.length,
    rows: data,
    order_ids_found: (data||[]).filter(r => r.order_id).length,
    order_ids_null:  (data||[]).filter(r => !r.order_id).length,
  });
}
