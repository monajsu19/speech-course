// Supabase Edge Function that Stripe calls when a payment succeeds or fails, so
// public.checkout_orders stays right even if the buyer closes the tab before success.html loads.
//
// It's also the only way the split plan's 2nd payment gets recorded, since that charge happens a month later.
//
// Setup (Stripe dashboard → Developers → Webhooks → Add endpoint):
//   URL     https://jiqunlcxytueqkotswjm.supabase.co/functions/v1/stripe-webhook
//   Events  payment_intent.succeeded, payment_intent.payment_failed, invoice.paid, invoice.payment_failed
// then copy the endpoint's signing secret into Supabase secrets as STRIPE_WEBHOOK_SECRET.
// Deployed with verify_jwt off: Stripe can't send a Supabase JWT, the signature check below replaces it.

import { recordPaymentResult, recordSecondPayment } from "../_shared/orders.ts";

const TOLERANCE_SECONDS = 300;
const HANDLED = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "invoice.paid",
  "invoice.payment_failed",
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

// https://docs.stripe.com/webhooks#verify-manually
async function verifySignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("webhook isn't set up yet", { status: 500 });

  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("stripe-signature") || "", secret))) {
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  if (!HANDLED.has(event.type)) return new Response("ignored", { status: 200 });

  try {
    if (event.type.startsWith("invoice.")) {
      await recordSecondPayment(event.data.object, event.type === "invoice.paid");
    } else {
      await recordPaymentResult(event.data.object, { inviteToCircle: true });
    }
  } catch (err) {
    // a non-2xx makes Stripe retry later
    console.error(`${event.type} ${event.id} failed:`, err);
    return new Response("couldn't save", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
