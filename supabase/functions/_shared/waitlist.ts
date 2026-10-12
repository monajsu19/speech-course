// Saves EmailOctopus waitlist contacts into public.waitlist_contacts.
//
// Secret (Supabase dashboard → Edge Functions → Secrets), alongside EMAILOCTOPUS_API_KEY:
//   EMAILOCTOPUS_WAITLIST_LIST_ID   the waitlist list (Lists → the list → Settings shows its ID)

const STATUSES = ["pending", "subscribed", "unsubscribed", "bounced", "complained", "deleted"] as const;
export type WaitlistStatus = (typeof STATUSES)[number];

export function isWaitlistStatus(s: unknown): s is WaitlistStatus {
  return (STATUSES as readonly unknown[]).includes(s);
}

export type WaitlistContact = {
  emailoctopus_id: string;
  email: string;
  fields: Record<string, unknown>;
  tags: string[];
  status: WaitlistStatus;
  joined_at: string | null;
  emailoctopus_updated_at: string;
};

export const API = "https://api.emailoctopus.com";

export function waitlistListId(): string | undefined {
  return Deno.env.get("EMAILOCTOPUS_WAITLIST_LIST_ID");
}

// A contact as EmailOctopus's API returns it (listing the list, or fetching one contact)
export function fromApi(c: any): WaitlistContact {
  return {
    emailoctopus_id: c.id,
    email: c.email_address,
    fields: c.fields ?? {},
    tags: c.tags ?? [],
    status: String(c.status).toLowerCase() as WaitlistStatus,
    joined_at: c.created_at,
    emailoctopus_updated_at: c.last_updated_at ?? c.created_at,
  };
}

// Fetches one waitlist contact's current state; null if they're no longer on the list
export async function fetchContact(id: string): Promise<WaitlistContact | null> {
  const key = Deno.env.get("EMAILOCTOPUS_API_KEY");
  const listId = waitlistListId();
  if (!key || !listId) throw new Error("set EMAILOCTOPUS_API_KEY and EMAILOCTOPUS_WAITLIST_LIST_ID first");
  const res = await fetch(`${API}/lists/${encodeURIComponent(listId)}/contacts/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw new Error(`EmailOctopus ${res.status}: ${await res.text()}`);
  return fromApi(await res.json());
}

// Goes through upsert_waitlist_contacts so an older update never overwrites a newer one
export async function saveContacts(contacts: WaitlistContact[]): Promise<void> {
  if (!contacts.length) return;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/upsert_waitlist_contacts`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contacts }),
  });
  if (!res.ok) throw new Error(`waitlist upsert failed (${res.status}): ${await res.text()}`);
}
