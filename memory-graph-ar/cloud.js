// Thin wrapper over supabase-js: sign-in by emailed code, and the storage/database calls sync needs.
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

let clientP;
export const client = () => clientP ??= import('supabase').then(m => m.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}));

const check = ({ data, error }) => { if (error) throw error; return data; };

export async function getSession() {
  return check(await (await client()).auth.getSession()).session;
}
export async function onAuthChange(cb) {
  (await client()).auth.onAuthStateChange((_event, session) => cb(session));
}
export async function sendCode(email) {
  check(await (await client()).auth.signInWithOtp({ email, options: { shouldCreateUser: true } }));
}
export async function verifyCode(email, token) {
  return check(await (await client()).auth.verifyOtp({ email, token, type: 'email' })).session;
}
export async function signOut() {
  check({ data: null, error: (await (await client()).auth.signOut()).error });
}

const BUCKET = 'mg';
// The five calls sync.js needs. A fake with the same shape is enough to test sync without a server.
export async function remote() {
  const sb = await client();
  return {
    listPlaces: async since => check(await sb.from('places').select('*').gte('updated_at', since).order('updated_at')),
    listMemories: async since => check(await sb.from('memories').select('*').gte('updated_at', since).order('updated_at')),
    upsertPlace: async row => { check(await sb.from('places').upsert(row)); },
    upsertMemory: async row => { check(await sb.from('memories').upsert(row)); },
    deleteMemory: async id => { check(await sb.from('memories').update({ deleted_at: new Date().toISOString() }).eq('id', id)); },
    upload: async (path, blob) => { check(await sb.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: blob.type || 'application/octet-stream' })); },
    download: async path => check(await sb.storage.from(BUCKET).download(path)),
    remove: async paths => { await sb.storage.from(BUCKET).remove(paths); },   // best effort: a leftover file is harmless
  };
}
