-- A cohort is now its own Circle space group ("Cohort N") of about 100 buyers, holding two private spaces:
-- Weekly Feedback (circle_cohorts.circle_space_id, as before) and Daily Drop.
alter table public.circle_cohorts
  add column circle_group_id bigint unique,
  add column circle_daily_space_id bigint unique;
