import {
  adminClient,
  bearerToken,
  corsHeaders,
  json,
  passwordError,
} from "../_shared/supabase.ts";

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
