// Calls Supabase's REST API with the service role key.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every Edge Function automatically;
// the service role bypasses RLS, which keeps the tables closed to the public anon key.

export async function rest(path: string, init: RequestInit): Promise<any> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method} ${path.split("?")[0]} failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}
