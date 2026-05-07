// api/get-entries.js — v2 with lazy free entries
import { createClient } from '@supabase/supabase-js';

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const VERCEL_URL = process.env.VERCEL_URL || 'https://lmtls-entries.vercel.app';
const FREE_ENTRIES = parseInt(process.env.FREE_SIGNUP_ENTRIES || '15');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const email = decodeURIComponent(req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Get participant
  const { data, error } = await supabase.from('entries')
    .select('email,first_name,total_entries,free_entries,paid_entries,alltime_entries,created_at,free_entries_claimed')
    .eq('email', email).single();

  if (error || !data) {
    return res.status(200).json({ found: false, total_entries: 0, message: 'No entries found' });
  }

  // Lazy free entries — grant if not yet claimed and they have 0 entries
  if (!data.free_entries_claimed && data.total_entries === 0) {
    // Get active giveaway
    const { data: giveaway } = await supabase.from('giveaways').select('id,name').eq('status','active').limit(1).single();

    if (giveaway) {
      await supabase.from('entries').update({
        total_entries: FREE_ENTRIES,
        free_entries:  FREE_ENTRIES,
        free_entries_claimed: true,
      }).eq('email', email);

      await supabase.from('entries_log').insert({
        email, event_type: 'signup', entries_awarded: FREE_ENTRIES,
        giveaway_id: giveaway.id,
        note: `Free entries claimed on login — ${giveaway.name}`,
      });

      // Update local data
      data.total_entries = FREE_ENTRIES;
      data.free_entries  = FREE_ENTRIES;
      data.free_entries_claimed = true;
    }
  }

  // Get recent activity
  const { data: logs } = await supabase.from('entries_log')
    .select('event_type,entries_awarded,order_amount,note,created_at')
    .eq('email', email)
    .not('event_type', 'eq', 'draw_win')
    .order('created_at', { ascending: false })
    .limit(10);

  // Get giveaway history for this participant
  const { data: history } = await supabase.from('giveaway_participants')
    .select('entries,won,created_at,giveaway_id,giveaways(name,status,completed_at,winner_name)')
    .eq('email', email)
    .order('created_at', { ascending: false });

  return res.status(200).json({
    found: true,
    first_name:    data.first_name,
    total_entries: data.total_entries,
    free_entries:  data.free_entries,
    paid_entries:  data.paid_entries,
    alltime_entries: data.alltime_entries || 0,
    member_since:  data.created_at,
    recent_activity: logs || [],
    giveaway_history: (history||[]).map(h => ({
      giveaway_name: h.giveaways?.name || 'Unknown',
      status:        h.giveaways?.status,
      entries:       h.entries,
      won:           h.won,
      completed_at:  h.giveaways?.completed_at,
      winner_name:   h.giveaways?.winner_name,
    })),
  });
}
