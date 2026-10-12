-- Runs the weekly-feedback Edge Function every 10 minutes. It only touches Circle when a posting window
-- opens or closes (or a small cohort needs folding), so most runs do nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'weekly-feedback',
  '*/10 * * * *',
  $$ select net.http_post(url := 'https://jiqunlcxytueqkotswjm.supabase.co/functions/v1/weekly-feedback') $$
);
