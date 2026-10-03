import {
  adminClient,
  corsHeaders,
  json,
  normalizeEmail,
  normalizeUsername,
  publicClient,
} from "../_shared/supabase.ts";

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
