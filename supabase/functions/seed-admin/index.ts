import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-seed-secret',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SEED_ADMIN_EMAIL = Deno.env.get('SEED_ADMIN_EMAIL');
const SEED_ADMIN_PASSWORD = Deno.env.get('SEED_ADMIN_PASSWORD');
const SEED_ADMIN_SECRET = Deno.env.get('SEED_ADMIN_SECRET');

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashArray = Array.from(new Uint8Array(derivedBits));
  const saltArray = Array.from(salt);
  return btoa(String.fromCharCode(...saltArray, ...hashArray));
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const combined = Uint8Array.from(atob(storedHash), (char) => char.charCodeAt(0));
    const salt = combined.slice(0, 16);
    const storedHashBytes = combined.slice(16);

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    const derivedHash = new Uint8Array(derivedBits);
    if (derivedHash.length !== storedHashBytes.length) return false;

    for (let i = 0; i < derivedHash.length; i += 1) {
      if (derivedHash[i] !== storedHashBytes[i]) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD || !SEED_ADMIN_SECRET) {
    return jsonResponse({ error: 'Seed admin configuration is incomplete' }, 500);
  }

  let body: { seed_secret?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const providedSeedSecret = req.headers.get('x-seed-secret') ?? body.seed_secret;
  if (!providedSeedSecret || providedSeedSecret !== SEED_ADMIN_SECRET) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { data: admins, error: adminsError } = await supabase
      .from('admins')
      .select('id, email, password_hash, role, is_active')
      .order('created_at', { ascending: true });

    if (adminsError) {
      throw adminsError;
    }

    const matchingEmailAdmin = admins?.find((admin) => admin.email === SEED_ADMIN_EMAIL) ?? null;
    const superAdmin = admins?.find((admin) => admin.role === 'SUPER_ADMIN') ?? null;
    const targetAdmin = matchingEmailAdmin ?? superAdmin ?? admins?.[0] ?? null;

    if (targetAdmin) {
      const passwordAlreadySynced = await verifyPassword(SEED_ADMIN_PASSWORD, targetAdmin.password_hash);
      const updates: Record<string, unknown> = {};

      if (targetAdmin.email !== SEED_ADMIN_EMAIL) {
        updates.email = SEED_ADMIN_EMAIL;
      }

      if (!targetAdmin.is_active) {
        updates.is_active = true;
      }

      if (!passwordAlreadySynced) {
        updates.password_hash = await hashPassword(SEED_ADMIN_PASSWORD);
      }

      if (Object.keys(updates).length === 0) {
        return jsonResponse({ success: true, message: 'Admin is already synchronized' });
      }

      const { error: updateError } = await supabase
        .from('admins')
        .update(updates)
        .eq('id', targetAdmin.id);

      if (updateError) {
        throw updateError;
      }

      if ('password_hash' in updates) {
        const { error: revokeError } = await supabase
          .from('refresh_tokens')
          .update({ is_revoked: true })
          .eq('admin_id', targetAdmin.id)
          .eq('is_revoked', false);

        if (revokeError) {
          throw revokeError;
        }
      }

      await supabase.from('admin_audit_logs').insert({
        admin_id: targetAdmin.id,
        action_type: 'ADMIN_SEED_SYNC',
        metadata: {
          email_updated: 'email' in updates,
          password_rotated: 'password_hash' in updates,
        },
      });

      return jsonResponse({
        success: true,
        message: 'Admin credentials synchronized successfully',
      });
    }

    const passwordHash = await hashPassword(SEED_ADMIN_PASSWORD);

    const { data: admin, error: createError } = await supabase
      .from('admins')
      .insert({
        email: SEED_ADMIN_EMAIL,
        password_hash: passwordHash,
        role: 'SUPER_ADMIN',
        is_active: true,
      })
      .select('id')
      .single();

    if (createError || !admin) {
      throw createError ?? new Error('Failed to create admin');
    }

    await supabase.from('admin_audit_logs').insert({
      admin_id: admin.id,
      action_type: 'ADMIN_SEEDED',
      metadata: { password_rotated: true },
    });

    return jsonResponse({ success: true, message: 'Admin created successfully' });
  } catch (error) {
    console.error('Seed admin error:', error);
    return jsonResponse({ error: 'Failed to synchronize admin credentials' }, 500);
  }
});
