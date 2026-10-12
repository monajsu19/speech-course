// Copies every contact on the EmailOctopus waitlist into public.waitlist_contacts.
// Run it once to import everyone who signed up before the webhook existed; it's safe to
// re-run any time (e.g. if the webhook was down), since rows are upserted and newer data wins.
//
// Run it with a secret key (Supabase dashboard → Project Settings → API Keys: an sb_secret_ key,
// or the legacy service_role key):
//   curl -X POST https://jiqunlcxytueqkotswjm.supabase.co/functions/v1/sync-waitlist \
//     -H "Authorization: Bearer <secret key>"
//
// Only secret keys are accepted, so the public key on the site can't trigger it.

import { API, fromApi, saveContacts, waitlistListId } from "../_shared/waitlist.ts";

// Asks Supabase whether the key may run upsert_waitlist_contacts (an empty batch, so nothing changes).
// Only secret keys can, which works for both the legacy service_role JWT and the newer sb_secret_ keys.
async function isSecretKey(key: string): Promise<boolean> {
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/upsert_waitlist_contacts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ contacts: [] }),
  });
  await res.body?.cancel();
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const callerKey = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!callerKey || !(await isSecretKey(callerKey))) {
    return new Response("unauthorized", { status: 401 });
  }

  const apiKey = Deno.env.get("EMAILOCTOPUS_API_KEY");
  const listId = waitlistListId();
  if (!apiKey || !listId) {
    return new Response("set EMAILOCTOPUS_API_KEY and EMAILOCTOPUS_WAITLIST_LIST_ID first", { status: 500 });
  }

  let synced = 0;
  let cursor: string | undefined;
  try {
    do {
      const url = new URL(`${API}/lists/${encodeURIComponent(listId)}/contacts`);
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("starting_after", cursor);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`EmailOctopus ${res.status}: ${await res.text()}`);
      const page = await res.json();

      await saveContacts(page.data.map(fromApi));
      synced += page.data.length;
      cursor = page.paging?.next?.starting_after ?? undefined;
    } while (cursor);
  } catch (err) {
    console.error(`waitlist sync stopped after ${synced} contacts:`, err);
    return new Response(`sync stopped after ${synced} contacts: ${err}`, { status: 500 });
  }

  return Response.json({ synced });
});
