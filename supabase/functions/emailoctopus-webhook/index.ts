// Supabase Edge Function that EmailOctopus calls when a contact joins or changes, so
// public.waitlist_contacts picks up new waitlist signups within a minute or so.
//
// Setup (EmailOctopus → Account settings → Webhooks → Add webhook):
//   URL     https://jiqunlcxytueqkotswjm.supabase.co/functions/v1/emailoctopus-webhook
//   Events  contact.created, contact.updated, contact.unsubscribed, contact.bounced,
//           contact.complained, contact.deleted
// then copy the webhook's secret into Supabase secrets as EMAILOCTOPUS_WEBHOOK_SECRET.
// Deployed with verify_jwt off: EmailOctopus can't send a Supabase JWT, the signature check below replaces it.

import {
  fetchContact,
  isWaitlistStatus,
  saveContacts,
  type WaitlistContact,
  type WaitlistStatus,
  waitlistListId,
} from "../_shared/waitlist.ts";

const HANDLED = new Set([
  "contact.created",
  "contact.updated",
  "contact.unsubscribed",
  "contact.bounced",
  "contact.complained",
  "contact.deleted",
]);

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// https://help.emailoctopus.com/article/314-webhooks — "sha256=" + HMAC-SHA256 of the raw body
async function verifySignature(payload: string, header: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return timingSafeEqual(header, expected);
}

// These events say what the status is now; for the rest it comes from contact_status
const STATUS_FROM_TYPE: Record<string, WaitlistStatus> = {
  "contact.deleted": "deleted",
  "contact.unsubscribed": "unsubscribed",
  "contact.bounced": "bounced",
  "contact.complained": "complained",
};

// null when the event doesn't carry a status we recognise (contact_status can be missing)
function toContact(event: any): WaitlistContact | null {
  const status = STATUS_FROM_TYPE[event.type] ?? String(event.contact_status).toLowerCase();
  if (!isWaitlistStatus(status)) return null;
  return {
    emailoctopus_id: event.contact_id,
    email: event.contact_email_address,
    fields: event.contact_fields ?? {},
    tags: event.contact_tags ?? [],
    status,
    joined_at: event.type === "contact.created" ? event.occurred_at : null,
    emailoctopus_updated_at: event.occurred_at,
  };
}

// Events without a usable status are looked up in EmailOctopus instead, so they still get saved
// with the contact's real current status. One bad event used to fail the whole delivery, and
// EmailOctopus kept retrying it while newer signups waited behind it.
async function toContacts(events: any[]): Promise<WaitlistContact[]> {
  const contacts: WaitlistContact[] = [];
  const unknown = new Set<string>();
  for (const e of events) {
    const c = toContact(e);
    if (c) contacts.push(c);
    else unknown.add(e.contact_id);
  }
  for (const id of unknown) {
    const c = await fetchContact(id);
    if (c) contacts.push(c);
    else console.warn(`contact ${id} had no status and is no longer on the waitlist; skipped`);
  }
  return contacts;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("EMAILOCTOPUS_WEBHOOK_SECRET");
  const listId = waitlistListId();
  if (!secret || !listId) return new Response("webhook isn't set up yet", { status: 500 });

  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("emailoctopus-signature") || "", secret))) {
    return new Response("bad signature", { status: 400 });
  }

  // One request carries up to 1000 events, from every list in the account (buyers included)
  const events: any[] = JSON.parse(payload);
  const waitlistEvents = events.filter(
    (e) => HANDLED.has(e.type) && e.list_id === listId && e.contact_id && e.contact_email_address,
  );

  let contacts: WaitlistContact[] = [];
  try {
    contacts = await toContacts(waitlistEvents);
    await saveContacts(contacts);
  } catch (err) {
    // a non-2xx makes EmailOctopus retry later (up to 9 times over ~10 days)
    console.error(`saving ${waitlistEvents.length} waitlist events failed:`, err);
    return new Response("couldn't save", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
