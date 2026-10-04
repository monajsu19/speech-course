// Supabase Edge Function behind the embedded Stripe payment form on checkout.html.
// The Stripe secret key lives in Supabase secrets and never reaches the browser.
//
//   GET   returns the publishable key and plan amounts, so test/live keys are switched in one place
//   POST  saves the buyer as a Stripe customer, then either
//           plan "full":  a $297 PaymentIntent
//           plan "split": a monthly $165 subscription that cancels itself after the 2nd payment
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY       required. rk_/sk_test_... while testing, rk_/sk_live_... for real sales
//   STRIPE_PUBLISHABLE_KEY  required. pk_test_... or pk_live_..., same mode as the secret key
//   SITE_URL                recommended. e.g. https://www.yoursite.com, used for CORS

const STRIPE_API = "https://api.stripe.com/v1";
// Pinned so response shapes (e.g. invoice.confirmation_secret) don't shift under us
const STRIPE_VERSION = "2025-03-31.basil";
const PRODUCT_ID = "articulation-bootcamp-baby-steps";
const PRODUCT_NAME = "Articulation Bootcamp: Baby Steps";
const AMOUNT_CENTS = 29700;
const SPLIT_COUNT = 2;
const SPLIT_CENTS = 16500; // $165 each, $330 total: the split plan costs more than paying in full

const FIELDS = ["name", "email", "line1", "line2", "city", "state", "postal_code", "country"] as const;
const REQUIRED = FIELDS.filter((k) => k !== "line2");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Fields = Record<(typeof FIELDS)[number], string>;

// Pages opened straight from disk (file://) send Origin "null"
const LOCAL_ORIGIN_RE = /^(null|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
// Vercel preview deploys of this project
const PREVIEW_ORIGIN_RE = /^https:\/\/speech-course-[a-z0-9-]+-mona-sus-projects\.vercel\.app$/;

function allowedOrigin(req: Request): string {
  const site = Deno.env.get("SITE_URL");
  if (!site) return "*";
  const { origin, hostname } = new URL(site);
  const twin = origin.replace(hostname, hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`);
  const reqOrigin = req.headers.get("origin") || "";
  const ok = reqOrigin === origin || reqOrigin === twin || LOCAL_ORIGIN_RE.test(reqOrigin) || PREVIEW_ORIGIN_RE.test(reqOrigin);
  return ok ? reqOrigin : origin;
}

function corsHeaders(req: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

class StripeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function stripe(path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_VERSION,
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new StripeError(body.error?.message || `Stripe error ${res.status}`, body.error?.code);
  return body;
}

// Subscriptions need a saved product; create it once with a fixed id
async function ensureProduct(): Promise<void> {
  try {
    await stripe("/products", { id: PRODUCT_ID, name: PRODUCT_NAME });
  } catch (err) {
    if (!(err instanceof StripeError && err.code === "resource_already_exists")) throw err;
  }
}

async function createSplitPlan(customerId: string, agreedAt: string): Promise<string> {
  await ensureProduct();

  // Payments land now and in one month; ending two weeks after the 2nd payment
  // leaves room for failed-payment retries but stops well before a 3rd charge.
  const cancelAt = new Date();
  cancelAt.setUTCMonth(cancelAt.getUTCMonth() + SPLIT_COUNT - 1);
  cancelAt.setUTCDate(cancelAt.getUTCDate() + 14);

  const sub = await stripe("/subscriptions", {
    customer: customerId,
    "items[0][price_data][currency]": "usd",
    "items[0][price_data][product]": PRODUCT_ID,
    "items[0][price_data][unit_amount]": String(SPLIT_CENTS),
    "items[0][price_data][recurring][interval]": "month",
    cancel_at: String(Math.floor(cancelAt.getTime() / 1000)),
    proration_behavior: "none",
    payment_behavior: "default_incomplete",
    "payment_settings[save_default_payment_method]": "on_subscription",
    description: `${PRODUCT_NAME} (${SPLIT_COUNT} payments)`,
    "metadata[terms_accepted_at]": agreedAt,
    "metadata[plan]": "split",
    "expand[0]": "latest_invoice.confirmation_secret",
  });

  const secret = sub.latest_invoice?.confirmation_secret?.client_secret;
  if (!secret) throw new Error(`subscription ${sub.id} has no payment to confirm`);
  return secret;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  const publishableKey = Deno.env.get("STRIPE_PUBLISHABLE_KEY");
  if (!Deno.env.get("STRIPE_SECRET_KEY") || !publishableKey) {
    return json(req, 500, { error: "checkout isn't set up yet" });
  }

  if (req.method === "GET") {
    return json(req, 200, {
      publishableKey,
      currency: "usd",
      amount: AMOUNT_CENTS,
      splitAmount: SPLIT_CENTS,
      splitCount: SPLIT_COUNT,
    });
  }
  if (req.method !== "POST") return json(req, 405, { error: "method not allowed" });

  let raw: Record<string, unknown>;
  try {
    raw = await req.json();
  } catch {
    return json(req, 400, { error: "invalid request" });
  }

  const f = {} as Fields;
  for (const key of FIELDS) f[key] = String(raw[key] ?? "").trim().slice(0, 200);

  const missing = REQUIRED.filter((k) => !f[k]);
  if (missing.length) return json(req, 400, { error: `missing ${missing.join(", ")}` });
  if (!EMAIL_RE.test(f.email)) return json(req, 400, { error: "that email doesn't look right" });
  if (raw.agree !== true) return json(req, 400, { error: "please agree to the terms" });
  const plan = raw.plan === "split" ? "split" : "full";

  const agreedAt = new Date().toISOString();

  try {
    const customer = await stripe("/customers", {
      name: f.name,
      email: f.email,
      "address[line1]": f.line1,
      "address[line2]": f.line2,
      "address[city]": f.city,
      "address[state]": f.state,
      "address[postal_code]": f.postal_code,
      "address[country]": f.country,
      "metadata[terms_accepted_at]": agreedAt,
    });

    if (plan === "split") {
      return json(req, 200, { clientSecret: await createSplitPlan(customer.id, agreedAt) });
    }

    const intent = await stripe("/payment_intents", {
      amount: String(AMOUNT_CENTS),
      currency: "usd",
      customer: customer.id,
      description: PRODUCT_NAME,
      receipt_email: f.email,
      "automatic_payment_methods[enabled]": "true",
      "metadata[terms_accepted_at]": agreedAt,
      "metadata[plan]": "full",
    });

    return json(req, 200, { clientSecret: intent.client_secret });
  } catch (err) {
    console.error("payment intent failed:", err);
    return json(req, 502, { error: "couldn't reach the payment processor" });
  }
});
