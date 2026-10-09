import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApplicationStatus, Database } from "@/types/database";

export type ApplicationFilterParams = {
  q?: string;
  status?: string;
  source?: string;
  cv?: string;
  /** Calendar year of applied_at. Records span 2015–2026. */
  year?: string;
  /** Employer (company) the applied-for role belongs to. Admin-only view. */
  employer?: string;
  /** Whether the applicant has an account attached to the record. */
  claimed?: string;
  /** Review filter (migration 029): unreviewed | seen | final. */
  review?: string;
  /** meets_requirements filter (migration 033): "1" | "0". */
  meets?: string;
};

// under_review is included now that migration 014 added it.
export const STATUSES: ApplicationStatus[] = [
  "pending",
  "under_review",
  "shortlisted",
  "rejected",
  "hired",
];

/**
 * The filtered applications query shared by the admin applications page and
 * its CSV export — same filters, same result set, just a different final
 * shape (paginated UI rows vs every matching row as CSV). Extracted so the
 * export can't drift out of sync with what the page actually shows.
 *
 * Takes the caller's own client rather than creating one, so RLS vs
 * admin-client stays the caller's decision (both current callers use the
 * admin client since the review-filter and employer-filter sub-queries need
 * to read rows an admin's own RLS already allows anyway).
 */
export async function buildApplicationsQuery(
  supabase: SupabaseClient<Database>,
  params: ApplicationFilterParams
) {
  let query = supabase
    .from("applications")
    .select(
      `id, applicant_name, applicant_email, applicant_phone, cover_letter, cv_url,
       status, employer_note, wp_post_id, wp_job_title, applied_at, applicant_id,
       meets_requirements, job:jobs(title, slug)`,
      { count: "exact" }
    )
    .order("applied_at", { ascending: false });

  if (params.q) {
    // Applicants are searched by the three things an admin actually knows: who
    // they are, how to reach them, and what they applied for. wp_job_title is
    // included because job_id is NULL for every migrated row, so the free-text
    // snapshot is the only role name those 4,355 records carry.
    const term = params.q.replace(/[%,()]/g, " ").trim();
    if (term) {
      query = query.or(
        `applicant_name.ilike.%${term}%,applicant_email.ilike.%${term}%,wp_job_title.ilike.%${term}%`
      );
    }
  }

  if (params.status && (STATUSES as string[]).includes(params.status)) {
    query = query.eq("status", params.status as ApplicationStatus);
  }

  // Historical rows are exactly the ones carrying a WordPress post id.
  if (params.source === "historical") query = query.not("wp_post_id", "is", null);
  if (params.source === "new") query = query.is("wp_post_id", null);

  // "migrated" now means anywhere we host it — Supabase for new uploads, R2 for
  // the recovered archive. Only an http:// value is still unreachable.
  if (params.cv === "legacy") query = query.like("cv_url", "http%");
  if (params.cv === "migrated") {
    query = query.not("cv_url", "is", null).not("cv_url", "like", "http%");
  }
  if (params.cv === "none") query = query.is("cv_url", null);

  // Whether the applicant has an account attached. Every archive row starts
  // unclaimed, so this is how you find who has come back and reconnected.
  if (params.claimed === "yes") query = query.not("applicant_id", "is", null);
  if (params.claimed === "no") query = query.is("applicant_id", null);

  // Flag, not filter-out: sorted via the order() below rather than excluded,
  // per the "never hide, only flag" decision (migration 033).
  if (params.meets === "1") query = query.eq("meets_requirements", true);
  if (params.meets === "0") query = query.eq("meets_requirements", false);

  if (params.review === "unreviewed" || params.review === "seen" || params.review === "final") {
    const { data: reviewRows } = await supabase
      .from("application_reviews")
      .select("application_id, mode");
    const rows = (reviewRows ?? []) as { application_id: string; mode: string }[];
    const anyIds = [...new Set(rows.map((r) => r.application_id))];
    const finalIds = [...new Set(rows.filter((r) => r.mode === "final").map((r) => r.application_id))];
    const NONE = "00000000-0000-0000-0000-000000000000";
    if (params.review === "unreviewed") {
      query = anyIds.length ? query.not("id", "in", `(${anyIds.join(",")})`) : query;
    } else if (params.review === "seen") {
      query = query.in("id", anyIds.length ? anyIds : [NONE]);
    } else {
      query = query.in("id", finalIds.length ? finalIds : [NONE]);
    }
  }

  const year = Number.parseInt(params.year ?? "", 10);
  if (Number.isFinite(year) && year > 2000 && year < 2100) {
    query = query.gte("applied_at", `${year}-01-01`).lt("applied_at", `${year + 1}-01-01`);
  }

  // Employer filter resolves to job ids first rather than filtering through the
  // embedded resource: PostgREST needs an !inner join for that, which would
  // silently drop every archive row (job_id is NULL on all 4,355 of them).
  if (params.employer) {
    const { data: employerJobs } = await supabase
      .from("jobs")
      .select("id")
      .eq("company_id", params.employer);
    const ids = ((employerJobs as { id: string }[] | null) ?? []).map((j) => j.id);
    // No jobs means no applications — an impossible id keeps the result empty
    // rather than silently ignoring the filter.
    query = query.in("job_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  }

  // Wrapped in an object rather than returned directly: Supabase's query
  // builder is thenable (so `await query` works without an explicit
  // .then()), which means an async function returning it bare gets
  // double-unwrapped by `await` — the caller would receive the already
  // -executed {data, error} response instead of the builder to add
  // .range()/.single() etc. to.
  return { query };
}
