// Hopex Express Cargo — paste as index.ts for complete-password-change.
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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const token = bearerToken(request);
  if (!token) return json({ error: "Authentication required." }, 401);

  try {
    const body = await request.json();
    const validationError = passwordError(body?.password);
    if (validationError) return json({ error: validationError }, 400);

    const admin = adminClient();
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Authentication required." }, 401);

    const { data: profile } = await admin
      .from("staff_profiles")
      .select("id,active")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (!profile?.active) return json({ error: "Your account is disabled." }, 403);

    const { error: passwordUpdateError } = await admin.auth.admin.updateUserById(authData.user.id, {
      password: body.password,
    });
    if (passwordUpdateError) return json({ error: "Password could not be changed." }, 400);

    const { error: profileUpdateError } = await admin
      .from("staff_profiles")
      .update({ must_change_password: false, updated_at: new Date().toISOString() })
      .eq("id", authData.user.id);
    if (profileUpdateError) return json({ error: "Password changed, but account access could not be restored. Contact an Admin." }, 500);

    await admin.from("staff_management_audit").insert({
      action: "PASSWORD_CHANGED",
      target_staff_id: authData.user.id,
      performed_by: authData.user.id,
    });

    return json({ success: true });
  } catch {
    return json({ error: "Password could not be changed." }, 500);
  }
});
