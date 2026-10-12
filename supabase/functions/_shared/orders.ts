// Reads and writes public.checkout_orders.

import { addToCircle } from "./circle.ts";
import { rest } from "./db.ts";
import { addBuyer } from "./emailoctopus.ts";

export type OrderStatus = "pending" | "paid" | "failed";

export async function insertOrder(row: Record<string, unknown>): Promise<void> {
  await rest("checkout_orders", { method: "POST", body: JSON.stringify(row) });
}

export async function updateOrderByCustomer(customerId: string, patch: Record<string, unknown>): Promise<void> {
  await rest(`checkout_orders?stripe_customer_id=eq.${encodeURIComponent(customerId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// Each checkout attempt gets its own Stripe customer, so the PaymentIntent's customer finds the row.
// A paid order never moves back to failed (a later split-plan charge can fail without undoing the purchase).
// Only the webhook sets inviteToCircle: the success page and the webhook arrive within seconds of each
// other, and Circle setup (which can create a new cohort space) is simpler to keep to one caller.
export async function recordPaymentResult(
  paymentIntent: any,
  { inviteToCircle = false } = {},
): Promise<OrderStatus | null> {
  const customerId = typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer?.id;
  if (!customerId) return null;

  if (paymentIntent.status === "succeeded") {
    await rest(
      `checkout_orders?stripe_customer_id=eq.${encodeURIComponent(customerId)}&status=neq.paid`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "paid",
          paid_at: new Date().toISOString(),
          stripe_payment_intent_id: paymentIntent.id,
        }),
      },
    );
    // Runs on every success (not only the first) so a Stripe retry also retries a failed sync
    const [order] = await rest(
      `checkout_orders?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id,name,email,plan,circle_synced_at`,
      { method: "GET" },
    );
    if (order) {
      // One failing shouldn't stop the other; a throw still makes Stripe retry, and both skip work already done
      const results = await Promise.allSettled([
        addBuyer(order),
        inviteToCircle && !order.circle_synced_at ? addToCircle(order) : null,
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    }
    return "paid";
  }

  if (paymentIntent.last_payment_error || paymentIntent.status === "canceled") {
    await rest(
      `checkout_orders?stripe_customer_id=eq.${encodeURIComponent(customerId)}&status=eq.pending`,
      { method: "PATCH", body: JSON.stringify({ status: "failed", stripe_payment_intent_id: paymentIntent.id }) },
    );
    return "failed";
  }

  return null;
}

// Split plan's 2nd charge: Stripe bills it a month later with billing_reason "subscription_cycle"
// (the 1st is "subscription_create" and is handled by recordPaymentResult). Only one cycle invoice
// happens because the subscription cancels itself before a 3rd.
export async function recordSecondPayment(invoice: any, paid: boolean): Promise<void> {
  if (invoice.billing_reason !== "subscription_cycle") return;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;

  const patch = paid
    ? { second_payment: "paid", second_paid_at: new Date().toISOString() }
    : { second_payment: "failed" };
  await rest(
    `checkout_orders?stripe_customer_id=eq.${encodeURIComponent(customerId)}&plan=eq.split&or=(second_payment.is.null,second_payment.neq.paid)`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}
