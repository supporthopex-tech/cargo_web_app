// Hopex Express Cargo — paste as index.ts for staff-admin.
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

type AdminContext = {
  admin: ReturnType<typeof adminClient>;
  actorId: string;
};

async function requireAdmin(request: Request): Promise<AdminContext | Response> {
  const token = bearerToken(request);
  if (!token) return json({ error: "Authentication required." }, 401);

  const admin = adminClient();
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "Authentication required." }, 401);

  const { data: profile } = await admin
    .from("staff_profiles")
    .select("id,role,active,must_change_password")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (!profile?.active || profile.must_change_password || profile.role !== "Admin") {
    return json({ error: "Admin access required." }, 403);
  }
  return { admin, actorId: authData.user.id };
}

async function ensureAnotherAdmin(admin: ReturnType<typeof adminClient>, targetId: string) {
  const { count } = await admin
    .from("staff_profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "Admin")
    .eq("active", true)
    .neq("id", targetId);
  return (count || 0) > 0;
}

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 120) : "";
}

function cleanPhone(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const context = await requireAdmin(request);
    if (context instanceof Response) return context;
    const { admin, actorId } = context;
    const body = await request.json();
    const action = body?.action;

    if (action === "create") {
      const name = cleanName(body.name);
      const username = normalizeUsername(body.username);
      const email = normalizeEmail(body.email);
      const phone = cleanPhone(body.phone);
      const role = body.role;
      const active = body.active !== false;
      const mustChangePassword = body.mustChangePassword === true;
      const validationError = passwordError(body.password);

      if (!name) return json({ error: "Full name is required." }, 400);
      if (!validUsername(username)) return json({ error: "Username must be 3-32 lowercase letters, numbers, dots, dashes or underscores." }, 400);
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "A valid email address is required." }, 400);
      if (!validRole(role)) return json({ error: "Invalid staff role." }, 400);
      if (validationError) return json({ error: validationError }, 400);

      const [usernameCheck, emailCheck] = await Promise.all([
        admin.from("staff_profiles").select("id").eq("username", username).maybeSingle(),
        admin.from("staff_profiles").select("id").ilike("email", email).maybeSingle(),
      ]);
      if (usernameCheck.data) return json({ error: "That username is already in use." }, 409);
      if (emailCheck.data) return json({ error: "That email address is already in use." }, 409);

      const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password: body.password,
        email_confirm: true,
        user_metadata: { name, initials, username },
      });
      if (createError || !created.user) return json({ error: "Staff account could not be created." }, 400);

      const targetId = created.user.id;
      const { error: profileError } = await admin.from("staff_profiles").upsert({
        id: targetId,
        email,
        username,
        name,
        initials,
        phone,
        role,
        active,
        must_change_password: mustChangePassword,
        created_by: actorId,
        disabled_at: active ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      if (profileError) {
        await admin.auth.admin.deleteUser(targetId);
        return json({ error: "Staff profile could not be created. The incomplete Auth account was removed." }, 500);
      }

      if (!active) {
        const { error: banError } = await admin.auth.admin.updateUserById(targetId, { ban_duration: "876000h" });
        if (banError) {
          await admin.auth.admin.deleteUser(targetId);
          return json({ error: "Staff status could not be applied. The incomplete account was removed." }, 500);
        }
      }

      const { error: auditError } = await admin.from("staff_management_audit").insert({
        action: "STAFF_CREATED",
        target_staff_id: targetId,
        performed_by: actorId,
        metadata: { role, active, username },
      });
      if (auditError) {
        await admin.auth.admin.deleteUser(targetId);
        return json({ error: "Staff audit could not be recorded. The incomplete account was removed." }, 500);
      }

      return json({ success: true, staffId: targetId });
    }

    const targetId = typeof body?.staffId === "string" ? body.staffId : "";
    if (!targetId) return json({ error: "Staff account is required." }, 400);

    const { data: target } = await admin
      .from("staff_profiles")
      .select("id,email,username,name,role,active")
      .eq("id", targetId)
      .maybeSingle();
    if (!target) return json({ error: "Staff account was not found." }, 404);

    if (action === "update") {
      const name = cleanName(body.name);
      const username = normalizeUsername(body.username);
      const email = normalizeEmail(body.email);
      const phone = cleanPhone(body.phone);
      const role = body.role;
      if (!name || !validUsername(username) || !/^\S+@\S+\.\S+$/.test(email) || !validRole(role)) {
        return json({ error: "Valid name, username, email and role are required." }, 400);
      }
      if (targetId === actorId && role !== "Admin") return json({ error: "You cannot remove your own Admin role." }, 400);
      if (target.role === "Admin" && role !== "Admin" && !(await ensureAnotherAdmin(admin, targetId))) {
        return json({ error: "At least one active Admin must remain." }, 400);
      }

      const [usernameCheck, emailCheck] = await Promise.all([
        admin.from("staff_profiles").select("id").eq("username", username).neq("id", targetId).maybeSingle(),
        admin.from("staff_profiles").select("id").ilike("email", email).neq("id", targetId).maybeSingle(),
      ]);
      if (usernameCheck.data) return json({ error: "That username is already in use." }, 409);
      if (emailCheck.data) return json({ error: "That email address is already in use." }, 409);

      if (email !== target.email.toLowerCase()) {
        const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, { email, email_confirm: true });
        if (authUpdateError) return json({ error: "Auth email could not be updated." }, 400);
      }

      const { error: profileUpdateError } = await admin.from("staff_profiles").update({
        name,
        username,
        email,
        phone,
        role,
        initials: name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
        updated_at: new Date().toISOString(),
      }).eq("id", targetId);
      if (profileUpdateError) {
        if (email !== target.email.toLowerCase()) {
          await admin.auth.admin.updateUserById(targetId, { email: target.email, email_confirm: true });
        }
        return json({ error: "Staff profile could not be updated." }, 500);
      }

      const auditRows: Array<{
        action: string;
        target_staff_id: string;
        performed_by: string;
        metadata: Record<string, unknown>;
      }> = [{
        action: "STAFF_UPDATED",
        target_staff_id: targetId,
        performed_by: actorId,
        metadata: { username, email },
      }];
      if (role !== target.role) auditRows.push({
        action: "ROLE_CHANGED",
        target_staff_id: targetId,
        performed_by: actorId,
        metadata: { from: target.role, to: role },
      });
      await admin.from("staff_management_audit").insert(auditRows);
      return json({ success: true });
    }

    if (action === "reset-password") {
      const validationError = passwordError(body.password);
      if (validationError) return json({ error: validationError }, 400);
      const { error: resetError } = await admin.auth.admin.updateUserById(targetId, { password: body.password });
      if (resetError) return json({ error: "Password could not be reset." }, 400);
      await admin.from("staff_profiles").update({
        must_change_password: body.mustChangePassword !== false,
        updated_at: new Date().toISOString(),
      }).eq("id", targetId);
      await admin.from("staff_management_audit").insert({
        action: "PASSWORD_RESET",
        target_staff_id: targetId,
        performed_by: actorId,
        metadata: { must_change_password: body.mustChangePassword !== false },
      });
      return json({ success: true });
    }

    if (action === "set-status") {
      const active = body.active === true;
      if (targetId === actorId && !active) return json({ error: "You cannot disable your own account." }, 400);
      if (!active && target.role === "Admin" && !(await ensureAnotherAdmin(admin, targetId))) {
        return json({ error: "At least one active Admin must remain." }, 400);
      }
      if (active === target.active) return json({ success: true });

      if (active) {
        const { error: unbanError } = await admin.auth.admin.updateUserById(targetId, { ban_duration: "none" });
        if (unbanError) return json({ error: "Auth account could not be enabled." }, 500);
        const { error: profileError } = await admin.from("staff_profiles").update({
          active: true,
          disabled_at: null,
          updated_at: new Date().toISOString(),
        }).eq("id", targetId);
        if (profileError) {
          await admin.auth.admin.updateUserById(targetId, { ban_duration: "876000h" });
          return json({ error: "Staff profile could not be enabled." }, 500);
        }
      } else {
        const { error: profileError } = await admin.from("staff_profiles").update({
          active: false,
          disabled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", targetId);
        if (profileError) return json({ error: "Staff profile could not be disabled." }, 500);
        const { error: banError } = await admin.auth.admin.updateUserById(targetId, { ban_duration: "876000h" });
        if (banError) {
          await admin.from("staff_profiles").update({ active: true, disabled_at: null }).eq("id", targetId);
          return json({ error: "Auth account could not be disabled." }, 500);
        }
      }

      await admin.from("staff_management_audit").insert({
        action: active ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED",
        target_staff_id: targetId,
        performed_by: actorId,
      });
      return json({ success: true });
    }

    return json({ error: "Unsupported staff action." }, 400);
  } catch {
    return json({ error: "The staff request could not be completed." }, 500);
  }
});
