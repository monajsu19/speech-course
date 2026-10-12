// Supabase Edge Function run every 10 minutes by pg_cron (see migrations/20261010010000_weekly_feedback_cron.sql).
// It keeps the Weekly Feedback cohort spaces on schedule (open for 48 hours from Saturday midnight in the
// earliest time zone, closed otherwise) and folds a small last cohort into the others once the course starts.
//
// Deployed with verify_jwt off and no secret: it takes no input, and every run only moves Circle toward the
// schedule (spaces already right are skipped), so an extra call from anyone changes nothing.

import { foldSmallCohort, syncPostingWindows } from "../_shared/circle.ts";

Deno.serve(async () => {
  try {
    const done = [...(await foldSmallCohort()), ...(await syncPostingWindows())];
    if (done.length) console.log(done.join("\n"));
    return Response.json({ done });
  } catch (err) {
    console.error("weekly-feedback failed:", err);
    return new Response("failed", { status: 500 });
  }
});
