// Hopex Express Cargo — paste as index.ts for staff-login.
import { createClient } from "npm:@supabase/supabase-js@2.112.2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function envKey(collectionName: string, legacyName: string): string {
  const collection = Deno.env.get(collectionName);
  if (collection) {
    try {
      const parsed = JSON.parse(collection) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch {
      return collection;
    }
  }

  const legacy = Deno.env.get(legacyName);
  if (!legacy) throw new Error(`Missing ${collectionName} / ${legacyName}.`);
  return legacy;
}

export function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export function publicClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function passwordError(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include a lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include a number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Password must include a special character.";
  return null;
}

export function validUsername(username: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username);
}

export function validRole(role: unknown): role is "Admin" | "Manager" | "Operations Staff" {
  return role === "Admin" || role === "Manager" || role === "Operations Staff";
}

const invalidCredentials = "Invalid email/username or password.";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await request.json();
    const identifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!identifier || identifier.length > 254) {
      return json({ error: invalidCredentials }, 400);
    }

    const admin = adminClient();
    const lookup = identifier.includes("@")
      ? admin.from("staff_profiles").select("id,email,active").ilike("email", normalizeEmail(identifier)).maybeSingle()
      : admin.from("staff_profiles").select("id,email,active").eq("username", normalizeUsername(identifier)).maybeSingle();
    const { data: profile, error: lookupError } = await lookup;

    if (body?.action === "request-reset") {
      if (!lookupError && profile?.active) {
        const redirectTo = Deno.env.get("STAFF_PORTAL_URL");
        await publicClient().auth.resetPasswordForEmail(
          profile.email,
          redirectTo ? { redirectTo } : undefined,
        );
      }
      return json({ success: true });
    }

    if (!password || password.length > 256 || lookupError || !profile) {
      return json({ error: invalidCredentials }, 401);
    }
    if (!profile.active) {
      return json({ error: "Your account is disabled. Please contact your administrator." }, 403);
    }

    const auth = publicClient();
    const { data, error } = await auth.auth.signInWithPassword({
      email: profile.email,
      password,
    });
    if (error || !data.session || !data.user || data.user.id !== profile.id) {
      return json({ error: invalidCredentials }, 401);
    }

    await admin
      .from("staff_profiles")
      .update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", profile.id);

    return json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: data.session.token_type,
    });
  } catch {
    return json({ error: "Unable to sign in right now. Please try again." }, 500);
  }
});
