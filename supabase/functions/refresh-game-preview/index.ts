import { createClient } from "npm:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405)

  const authorization = request.headers.get("Authorization")
  if (!authorization) return json({ error: "Authentication required." }, 401)

  const supabaseUrl = Deno.env.get("SUPABASE_URL")
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")
  if (!supabaseUrl || !anonKey) return json({ error: "Supabase environment is unavailable." }, 500)

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  })
  const { data: authData, error: authError } = await supabase.auth.getUser()
  if (authError || !authData.user) return json({ error: "Invalid session." }, 401)

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .single()
  if (profileError || !profile || !["admin", "mod"].includes(profile.role)) {
    return json({ error: "Staff access required." }, 403)
  }

  let payload: { game_id?: unknown }
  try {
    payload = await request.json()
  } catch {
    return json({ error: "Invalid JSON body." }, 400)
  }
  const gameId = String(payload.game_id || "")
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) return json({ error: "A valid game ID is required." }, 400)

  const githubToken = Deno.env.get("GITHUB_ACTIONS_TOKEN")
  const githubRepository = Deno.env.get("GITHUB_REPOSITORY") || "63kitsune/creatdle"
  const githubWorkflow = Deno.env.get("GITHUB_WORKFLOW") || "refresh-previews.yml"
  if (!githubToken) {
    return json({ error: "GITHUB_ACTIONS_TOKEN has not been configured for this Edge Function." }, 503)
  }

  const githubResponse = await fetch(`https://api.github.com/repos/${githubRepository}/actions/workflows/${githubWorkflow}/dispatches`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "creatdle-preview-refresh",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { game_id: gameId },
    }),
  })
  if (!githubResponse.ok) {
    const details = (await githubResponse.text()).slice(0, 500)
    return json({ error: `GitHub rejected the refresh request (${githubResponse.status}).`, details }, 502)
  }

  return json({ queued: true, game_id: gameId }, 202)
})
