// Invites paying buyers to the Circle community and puts each one in a cohort of about 100 people.
// A cohort is its own space group ("Cohort N") holding two private spaces only its members can see,
// Weekly Feedback and Daily Drop, plus a matching member tag. Circle emails the buyer an invite to set a
// password and join. Split-plan buyers get in after their 1st payment, same as full-pay.
//
// The weekly-feedback function uses the rest of this file to open the Weekly Feedback spaces for posting for
// 48 hours each Saturday, and to fold a small last cohort into the others when the course starts.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets). Until CIRCLE_API_TOKEN is set, buyers just aren't invited:
//   CIRCLE_API_TOKEN          Circle → Developers → Tokens, type "Admin v2" (needs the Business plan or above)
//   CIRCLE_SPACE_IDS          optional, comma-separated extra spaces every buyer joins, on top of SHARED_SPACE_IDS
//   CIRCLE_MEMBER_TAG_IDS     optional, comma-separated member tags every buyer gets

import { rest } from "./db.ts";

const API = "https://app.circle.so/api/admin/v2";

// Articulation Bootcamp, October 2026 run. For the next run, change these (and start a fresh circle_cohorts table).
const RUN = { label: "Oct 2026", slug: "oct-2026" };
const COURSE_START = Date.UTC(2026, 9, 26); // Monday Oct 26
const WEEKS = 6;
// Spaces every buyer joins, whatever their cohort: the course, Live Sessions, Announcements
const SHARED_SPACE_IDS = [2874676, 2874719, 2903351];
const COHORT_SIZE = 100;
// At the course start, a last cohort smaller than this is split up among the others
const MIN_COHORT_SIZE = 50;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// "Midnight" here means midnight in the world's earliest time zone (UTC+14, Kiribati), so windows open
// before anyone, anywhere, has reached that day
const EARLIEST_ZONE_OFFSET = 14 * HOUR;
const POSTING_HOURS = 48;

// Cohorts fill in order until the course starts; after that, late buyers join the smallest cohort
export const FILL_CUTOFF = new Date(COURSE_START - EARLIEST_ZONE_OFFSET);

// The week whose Saturday posting window is open at `now`, or null between windows
export function openWeek(now = Date.now()): number | null {
  for (let week = 1; week <= WEEKS; week++) {
    const saturday = COURSE_START + (5 + 7 * (week - 1)) * DAY;
    const opens = saturday - EARLIEST_ZONE_OFFSET;
    if (now >= opens && now < opens + POSTING_HOURS * HOUR) return week;
  }
  return null;
}

function ids(name: string): number[] {
  return (Deno.env.get(name) || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
}

function token(): string | undefined {
  return Deno.env.get("CIRCLE_API_TOKEN");
}

// A GET or DELETE that 404s returns null ("not there" / "already gone"); any other failure throws
async function circle(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 404 && ["GET", "DELETE"].includes(init.method || "GET")) return null;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Circle ${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function doc(...paragraphs: string[]) {
  return {
    body: {
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    },
  };
}

async function createPost(spaceId: number, name: string, paragraphs: string[], pinned: boolean): Promise<number> {
  const res = await circle("/posts", {
    method: "POST",
    body: JSON.stringify({ space_id: spaceId, name, status: "published", is_pinned: pinned, tiptap_body: doc(...paragraphs) }),
  });
  return res.post?.id ?? res.id;
}

// circle_space_id is the cohort's Weekly Feedback space
type Cohort = {
  number: number;
  circle_group_id: number | null;
  circle_space_id: number | null;
  circle_daily_space_id: number | null;
  circle_tag_id: number | null;
};

async function getCohort(n: number): Promise<Cohort> {
  const [cohort] = await rest(
    `circle_cohorts?number=eq.${n}&select=number,circle_group_id,circle_space_id,circle_daily_space_id,circle_tag_id`,
    { method: "GET" },
  );
  return cohort;
}

async function saveCohort(n: number, patch: Record<string, unknown>): Promise<void> {
  await rest(`circle_cohorts?number=eq.${n}`, { method: "PATCH", body: JSON.stringify(patch) });
}

function cohortSlug(kind: "cohort" | "weekly-feedback" | "daily-drop", n: number): string {
  return kind === "cohort" ? `${RUN.slug}-cohort-${n}` : `${kind}-${RUN.slug}-cohort-${n}`;
}

async function findBySlug(path: "/spaces" | "/space_groups", slug: string): Promise<number | null> {
  for (let page = 1; ; page++) {
    const res = await circle(`${path}?per_page=100&page=${page}`);
    const found = res?.records?.find((r: any) => r.slug === slug);
    if (found) return found.id;
    if (!res?.has_next_page) return null;
  }
}

// A private space in the cohort's group, hidden from everyone outside the cohort
async function createCohortSpace(groupId: number, name: string, slug: string, emoji: string): Promise<number> {
  const res = await circle("/spaces", {
    method: "POST",
    body: JSON.stringify({
      space_group_id: groupId,
      name,
      slug,
      emoji,
      space_type: "basic",
      is_private: true,
      is_hidden_from_non_members: true,
    }),
  });
  return (res.space?.id ?? res.id) as number;
}

// Creates the cohort's space group, its two private spaces (each with a pinned welcome post) and its
// member tag the first time someone lands in it. Each id is saved as soon as it exists, so a retry after
// a failure picks up where it stopped. Weekly Feedback posting starts closed; the weekly-feedback function
// opens it on Saturdays.
async function ensureCohort(n: number): Promise<Cohort> {
  const cohort = await getCohort(n);
  if (cohort.circle_group_id && cohort.circle_space_id && cohort.circle_daily_space_id && cohort.circle_tag_id) {
    return cohort;
  }

  // A claim older than 5 minutes means that caller died partway, so it's safe to take over
  const claimed = await rest(
    `circle_cohorts?number=eq.${n}&or=(setup_claimed_at.is.null,setup_claimed_at.lt.${new Date(Date.now() - 5 * 60_000).toISOString()})`,
    { method: "PATCH", body: JSON.stringify({ setup_claimed_at: new Date().toISOString() }) },
  );
  if (!claimed.length) throw new Error(`cohort ${n} is being set up by another request; Stripe will retry`);

  try {
    return await setUpCohort(cohort);
  } catch (err) {
    // Let the next attempt start right away instead of waiting out the claim
    await saveCohort(n, { setup_claimed_at: null });
    throw err;
  }
}

async function setUpCohort(cohort: Cohort): Promise<Cohort> {
  const n = cohort.number;
  let groupId = cohort.circle_group_id ?? await findBySlug("/space_groups", cohortSlug("cohort", n));
  if (!groupId) {
    const res = await circle("/space_groups", {
      method: "POST",
      body: JSON.stringify({
        name: `Cohort ${n}`,
        slug: cohortSlug("cohort", n),
        is_hidden_from_non_members: true,
        hide_non_member_spaces_from_sidebar: true,
        allow_members_to_create_spaces: false,
      }),
    });
    groupId = (res.space_group?.id ?? res.id) as number;
  }
  await saveCohort(n, { circle_group_id: groupId });

  let spaceId = cohort.circle_space_id ?? await findBySlug("/spaces", cohortSlug("weekly-feedback", n));
  if (!spaceId) {
    spaceId = await createCohortSpace(groupId, "Weekly Feedback", cohortSlug("weekly-feedback", n), "🔍");
    await createPost(spaceId, `Welcome to Cohort ${n} 👋`, [
      "This is your cohort's private Weekly Feedback space. Only the people in your cohort can see it.",
      "Every Saturday it opens for 48 hours. Post your 1-minute impromptu video as a new post here, then leave feedback on your cohort-mates' videos.",
    ], true);
    // Admins can post in a closed space, so the welcome post above goes up first
    await circle(`/spaces/${spaceId}`, { method: "PUT", body: JSON.stringify({ is_post_disabled: true }) });
  }
  await saveCohort(n, { circle_space_id: spaceId });

  let dailyId = cohort.circle_daily_space_id ?? await findBySlug("/spaces", cohortSlug("daily-drop", n));
  if (!dailyId) {
    dailyId = await createCohortSpace(groupId, "Daily Drop", cohortSlug("daily-drop", n), "🎙️");
    await createPost(dailyId, `Cohort ${n}'s Daily Drop 🎙️`, [
      "This is your cohort's private Daily Drop space. Only the people in your cohort can see it.",
    ], true);
  }
  await saveCohort(n, { circle_daily_space_id: dailyId });

  let tagId = cohort.circle_tag_id;
  if (!tagId) {
    const res = await circle("/member_tags", {
      method: "POST",
      body: JSON.stringify({
        name: `Cohort ${n} · ${RUN.label}`,
        is_public: true,
        display_format: "label",
        display_locations: { member_directory: true, profile_page: true, post_bio: false },
      }),
    });
    tagId = (res.member_tag?.id ?? res.id) as number;
  }
  await saveCohort(n, { circle_tag_id: tagId, setup_claimed_at: null });

  return { number: n, circle_group_id: groupId, circle_space_id: spaceId, circle_daily_space_id: dailyId, circle_tag_id: tagId };
}

async function isMember(email: string): Promise<boolean> {
  return (await circle(`/community_members/search?email=${encodeURIComponent(email)}`)) !== null;
}

async function inSpace(email: string, spaceId: number): Promise<boolean> {
  return (await circle(`/space_member?email=${encodeURIComponent(email)}&space_id=${spaceId}`)) !== null;
}

async function addToSpace(email: string, spaceId: number): Promise<void> {
  if (await inSpace(email, spaceId)) return;
  await circle("/space_members", { method: "POST", body: JSON.stringify({ email, space_id: spaceId }) });
}

async function addToGroup(email: string, groupId: number): Promise<void> {
  const q = `email=${encodeURIComponent(email)}&space_group_id=${groupId}`;
  if ((await circle(`/space_group_member?${q}`)) !== null) return;
  await circle("/space_group_members", { method: "POST", body: JSON.stringify({ email, space_group_id: groupId }) });
}

// Puts a member in the cohort's group, both of its spaces, and its tag
async function addToCohort(email: string, cohort: Cohort): Promise<void> {
  await addToGroup(email, cohort.circle_group_id!);
  await addToSpace(email, cohort.circle_space_id!);
  await addToSpace(email, cohort.circle_daily_space_id!);
  await tag(email, cohort.circle_tag_id!);
}

async function tag(email: string, tagId: number): Promise<void> {
  const res = await fetch(`${API}/tagged_members`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ user_email: email, member_tag_id: tagId }),
  });
  // 422 is Circle refusing a tag the member already has
  if (!res.ok && res.status !== 422) throw new Error(`Circle tag ${res.status}: ${await res.text()}`);
}

export async function addToCircle(order: { id: string; name: string; email: string }): Promise<void> {
  if (!token()) return;

  const n = await rest("rpc/assign_cohort", {
    method: "POST",
    body: JSON.stringify({ order_id: order.id, capacity: COHORT_SIZE, fill_cutoff: FILL_CUTOFF.toISOString() }),
  });
  const cohort = await ensureCohort(n);
  const sharedSpaceIds = [...new Set([...SHARED_SPACE_IDS, ...ids("CIRCLE_SPACE_IDS")])];
  const sharedTagIds = ids("CIRCLE_MEMBER_TAG_IDS");

  if (await isMember(order.email)) {
    // Already in the community (an earlier attempt got partway, or they joined before buying)
    for (const id of sharedSpaceIds) await addToSpace(order.email, id);
    for (const id of sharedTagIds) await tag(order.email, id);
    await addToCohort(order.email, cohort);
  } else {
    const res = await fetch(`${API}/community_members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: order.email,
        name: order.name.trim(),
        skip_invitation: false,
        space_group_ids: [cohort.circle_group_id],
        space_ids: [...sharedSpaceIds, cohort.circle_space_id, cohort.circle_daily_space_id],
        member_tag_ids: [...sharedTagIds, cohort.circle_tag_id],
      }),
    });
    if (!res.ok) throw new Error(`Circle invite ${res.status}: ${await res.text()}`);
  }

  await rest(`checkout_orders?id=eq.${order.id}`, {
    method: "PATCH",
    body: JSON.stringify({ circle_synced_at: new Date().toISOString() }),
  });
}

// Brings every cohort's Weekly Feedback space in line with the schedule: open (with that week's pinned post) during a
// Saturday window, closed otherwise. Safe to run as often as you like; spaces already right are skipped.
export async function syncPostingWindows(now = Date.now()): Promise<string[]> {
  if (!token()) return [];
  const week = openWeek(now);
  const cohorts = await rest(
    "circle_cohorts?circle_space_id=not.is.null&select=number,circle_space_id,posting_week,weekly_post_id&order=number",
    { method: "GET" },
  );
  const done: string[] = [];

  for (const c of cohorts) {
    if (c.posting_week === week) continue;

    if (week === null) {
      await circle(`/spaces/${c.circle_space_id}`, { method: "PUT", body: JSON.stringify({ is_post_disabled: true }) });
      await rest(`circle_cohorts?number=eq.${c.number}`, { method: "PATCH", body: JSON.stringify({ posting_week: null }) });
      done.push(`closed cohort ${c.number}`);
      continue;
    }

    await circle(`/spaces/${c.circle_space_id}`, { method: "PUT", body: JSON.stringify({ is_post_disabled: false }) });
    if (c.weekly_post_id) {
      await circle(`/posts/${c.weekly_post_id}`, { method: "PUT", body: JSON.stringify({ is_pinned: false }) });
    }
    const postId = await createPost(c.circle_space_id, `Week ${week}: post your 1-minute video`, [
      "Feedback day is here! This space is open for posting for the next 48 hours.",
      "Share your 1-minute impromptu video as a new post in this space, then leave feedback on your cohort-mates' videos.",
    ], true);
    await rest(`circle_cohorts?number=eq.${c.number}`, {
      method: "PATCH",
      body: JSON.stringify({ posting_week: week, weekly_post_id: postId }),
    });
    done.push(`opened week ${week} for cohort ${c.number}`);
  }
  return done;
}

// At the course start, splits a last cohort smaller than MIN_COHORT_SIZE among the others, one person
// at a time into whichever is smallest, then deletes its spaces, group and tag. Nothing has been posted yet,
// since the first window is the first Saturday. Does nothing before FILL_CUTOFF or once cohorts are even.
export async function foldSmallCohort(now = Date.now()): Promise<string[]> {
  if (!token() || now < FILL_CUTOFF.getTime()) return [];

  const cohorts: (Cohort & { size: number })[] = (await rest(
    "circle_cohorts?select=number,circle_group_id,circle_space_id,circle_daily_space_id,circle_tag_id,checkout_orders(count)&order=number",
    { method: "GET" },
  )).map((c: any) => ({ ...c, size: c.checkout_orders[0]?.count ?? 0 }));
  if (cohorts.length < 2) return [];

  const last = cohorts[cohorts.length - 1];
  if (last.size >= MIN_COHORT_SIZE) return [];
  const others = cohorts.slice(0, -1);

  const members = await rest(`checkout_orders?cohort=eq.${last.number}&select=id,email,circle_synced_at`, {
    method: "GET",
  });
  const done: string[] = [];
  for (const m of members) {
    const target = others.reduce((a, b) => (b.size < a.size ? b : a));
    // Someone not set up in Circle yet only needs the new cohort number; their setup will use it
    if (m.circle_synced_at) {
      await addToCohort(m.email, await ensureCohort(target.number));
      for (const spaceId of [last.circle_space_id, last.circle_daily_space_id]) {
        if (!spaceId) continue;
        await circle(`/space_members?email=${encodeURIComponent(m.email)}&space_id=${spaceId}`, { method: "DELETE" });
      }
      if (last.circle_tag_id) {
        await circle(`/tagged_members?user_email=${encodeURIComponent(m.email)}&member_tag_id=${last.circle_tag_id}`, { method: "DELETE" });
      }
    }
    await rest(`checkout_orders?id=eq.${m.id}`, { method: "PATCH", body: JSON.stringify({ cohort: target.number }) });
    target.size++;
    done.push(`moved ${m.email} from cohort ${last.number} to ${target.number}`);
  }

  for (const spaceId of [last.circle_space_id, last.circle_daily_space_id]) {
    if (spaceId) await circle(`/spaces/${spaceId}`, { method: "DELETE" });
  }
  if (last.circle_group_id) await circle(`/space_groups/${last.circle_group_id}`, { method: "DELETE" });
  if (last.circle_tag_id) await circle(`/member_tags/${last.circle_tag_id}`, { method: "DELETE" });
  await rest(`circle_cohorts?number=eq.${last.number}`, { method: "DELETE" });
  done.push(`removed cohort ${last.number}`);
  return done;
}
