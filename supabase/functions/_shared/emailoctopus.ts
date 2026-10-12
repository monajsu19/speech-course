// Adds paying buyers to an EmailOctopus list, where an automation sends the welcome email,
// and tags them "purchased" on the waitlist too so waitlist sends can leave buyers out.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets). Until both are set, buyers just aren't synced:
//   EMAILOCTOPUS_API_KEY            from https://emailoctopus.com/developer/api-keys
//   EMAILOCTOPUS_LIST_ID            the buyers list (Lists → the list → Settings shows its ID)
//   EMAILOCTOPUS_WAITLIST_LIST_ID   optional here; when set, buyers on the waitlist get tagged there

import { createHash } from "node:crypto";

const API = "https://api.emailoctopus.com";

export async function addBuyer(order: { name: string; email: string; plan: string }): Promise<void> {
  const key = Deno.env.get("EMAILOCTOPUS_API_KEY");
  const listId = Deno.env.get("EMAILOCTOPUS_LIST_ID");
  if (!key || !listId) return;

  const [first, ...rest] = order.name.trim().split(/\s+/);
  // PUT creates or updates, so the success page and the webhook both calling this is harmless;
  // "contact joins list" automations only fire the first time
  const res = await fetch(`${API}/lists/${encodeURIComponent(listId)}/contacts`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email_address: order.email,
      fields: { FirstName: first, LastName: rest.join(" ") },
      tags: { purchased: true, [order.plan === "split" ? "split-pay" : "full-pay"]: true },
      status: "subscribed",
    }),
  });
  if (!res.ok) throw new Error(`EmailOctopus ${res.status}: ${await res.text()}`);

  await tagOnWaitlist(key, order.email);
}

// Updates the contact by the MD5 of their lowercased email, which (unlike the PUT above) never
// creates one, so buyers who skipped the waitlist aren't added to it. Their waitlist_contacts
// row picks up the tag through the emailoctopus-webhook function.
async function tagOnWaitlist(key: string, email: string): Promise<void> {
  const listId = Deno.env.get("EMAILOCTOPUS_WAITLIST_LIST_ID");
  if (!listId) return;

  const contactId = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  const res = await fetch(`${API}/lists/${encodeURIComponent(listId)}/contacts/${contactId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tags: { purchased: true } }),
  });
  if (res.status === 404) return; // not on the waitlist
  if (!res.ok) throw new Error(`EmailOctopus waitlist tag ${res.status}: ${await res.text()}`);
}
