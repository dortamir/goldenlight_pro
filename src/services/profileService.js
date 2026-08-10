import { supabase } from './supabase';

export async function getProfile(userId) {
  if (!supabase || !userId) {
    throw new Error('Profile not available');
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, phone, profession, points_balance, membership_level, approved_purchases_count, created_at, updated_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}
