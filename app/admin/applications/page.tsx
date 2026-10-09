import Link from "next/link";
import { unstable_cache } from "next/cache";
import { Search, ChevronLeft, ChevronRight, Phone, Mail, SlidersHorizontal, Download } from "lucide-react";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHead } from "@/components/dashboard-shell";
import { EmptyState } from "@/components/dashboard-ui";
import { CvLink } from "@/components/cv-link";
import { Drawer } from "@/components/drawer";
import {
  ApplicationDetailBody,
  type ApplicantProfileDetail,
  type ApplicationDetail,
  type ApplicationEventItem,
} from "@/components/application-detail";
import { signApplicationCv } from "@/lib/cv-actions";
import { setApplicationStatusAdmin } from "@/app/admin/actions";
import { StatusSelect, NoteForm } from "@/components/application-status-form";
import { ToastFromSearchParams } from "@/components/toast-from-search-params";
import { RequirementsBadge, ReviewStatusBadge } from "@/components/status-badge";
import { ReviewPanel } from "@/components/review-panel";
import { applicantCards } from "@/lib/applicant-cards";
import { reviewSummaries, reviewSummaryFor } from "@/lib/application-reviews";
import { cvStatus } from "@/lib/cv";
import { dash } from "@/lib/content";
import { displayApplicant } from "@/lib/utils";
import { buildApplicationsQuery, STATUSES } from "@/lib/admin-applications-query";
import type { ApplicationStatus } from "@/types/database";

const PER_PAGE = 50;

// Neither of these depends on the page's own filters or the drawer's ?id —
// they were re-run in full on every row click (which reloads this page with
// id set), making the drawer feel slow for no reason. Both are admin-gated
// data with no meaningful per-request variance, so an hour-old answer is fine.
const getCachedYearRange = unstable_cache(
  async () => {
    const supabase = createAdminClient();
    const [{ data: oldest }, { data: newest }] = await Promise.all([
      supabase
        .from("applications")
        .select("applied_at")
        .order("applied_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("applications")
        .select("applied_at")
        .order("applied_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      oldest: (oldest as { applied_at: string } | null)?.applied_at ?? null,
      newest: (newest as { applied_at: string } | null)?.applied_at ?? null,
    };
  },
  ["admin_applications_year_range"],
  { revalidate: 3600 }
);

const getCachedEmployers = unstable_cache(
  async () => {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("companies")
      .select("id, name")
      .order("name")
      .limit(500);
    return (data as { id: string; name: string }[] | null) ?? [];
  },
  ["admin_applications_employers"],
  { revalidate: 3600 }
);

interface Row {
  id: string;
  applicant_name: string | null;
  applicant_email: string;
  applicant_phone: string | null;
  cover_letter: string | null;
  cv_url: string | null;
  status: ApplicationStatus;
  employer_note: string | null;
  wp_post_id: number | null;
  wp_job_title: string | null;
  applied_at: string;
  applicant_id: string | null;
  meets_requirements: boolean | null;
  job: { title: string; slug: string } | null;
}

interface Params {
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
  page?: string;
  /** Open drawer. */
  id?: string;
  updated?: string;
  reviewed?: string;
}

function href(current: Params, changes: Partial<Record<keyof Params, string | null>>) {
  const next = new URLSearchParams();
  const merged = { ...current, ...changes } as Record<string, string | null | undefined>;
  for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
  const qs = next.toString();
  return qs ? `/admin/applications?${qs}` : "/admin/applications";
}

// Matches ApplicationFilterParams in lib/admin-applications-query.ts — only
// the actual filters, not pagination/drawer state (page, id, updated,
// reviewed), so the export link reflects what's filtered, not what's open.
const EXPORT_PARAM_KEYS = [
  "q",
  "status",
  "source",
  "cv",
  "year",
  "employer",
  "claimed",
  "review",
  "meets",
] as const;

function exportHref(current: Params) {
  const next = new URLSearchParams();
  for (const key of EXPORT_PARAM_KEYS) {
    const value = current[key];
    if (value) next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `/admin/applications/export?${qs}` : "/admin/applications/export";
}

export default async function AdminApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const { supabase, userId } = await requireProfile("admin");
  const params = await searchParams;

  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const from = (page - 1) * PER_PAGE;

  const { query } = await buildApplicationsQuery(supabase, params);
  const { data, count, error } = await query.range(from, from + PER_PAGE - 1);

  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));
  const reviews = await reviewSummaries(
    supabase,
    rows.map((row) => row.id)
  );

  // Year options come from the data's real span, not a hardcoded range — the
  // archive starts in 2015 and the newest arrives whenever someone applies.
  const [yearRange, employers] = await Promise.all([
    getCachedYearRange(),
    // Admin-only: companies are no longer world-readable (migration 016), and
    // this view is behind requireProfile("admin").
    getCachedEmployers(),
  ]);

  const firstYear = yearRange.oldest
    ? new Date(yearRange.oldest).getFullYear()
    : new Date().getFullYear();
  const lastYear = yearRange.newest
    ? new Date(yearRange.newest).getFullYear()
    : new Date().getFullYear();
  const years = Array.from(
    { length: Math.max(1, lastYear - firstYear + 1) },
    (_, i) => lastYear - i
  );

  // DRAWER — read-only. Moving an application through its stages is the
  // employer's decision, per the brief, so there is no status control here.
  const openId = params.id ?? null;
  const returnTo = href(params, { id: openId });
  let detail: ApplicationDetail | null = null;
  let events: ApplicationEventItem[] = [];
  let drawerCvStatus: "none" | "legacy" | "ready" = "none";
  let drawerCard: { headline: string | null; avatarSrc: string | null } | undefined;
  let profileDetail: ApplicantProfileDetail | null = null;

  if (openId) {
    const [{ data: one }, { data: log }, cards, { data: profile }] = await Promise.all([
      supabase
        .from("applications")
        .select(
          `id, applicant_name, applicant_email, applicant_phone, cover_letter, cv_url,
           status, employer_note, applied_at, wp_post_id, wp_job_title, meets_requirements,
           job:jobs(id, title, slug)`
        )
        .eq("id", openId)
        .maybeSingle(),
      supabase
        .from("application_events")
        .select("id, from_status, to_status, created_at, note")
        .eq("application_id", openId)
        .order("created_at", { ascending: false }),
      applicantCards(supabase, [openId]),
      supabase.rpc("applicant_profile_detail", { p_application_id: openId }),
    ]);

    if (one) {
      const row = one as unknown as ApplicationDetail & { cv_url: string | null };
      drawerCard = cards.get(openId);
      detail = {
        ...row,
        applicant: drawerCard
          ? { headline: drawerCard.headline, avatar_url: null }
          : null,
      };
      events = (log ?? []) as unknown as ApplicationEventItem[];
      drawerCvStatus = cvStatus(row.cv_url);
      profileDetail = profile?.[0] ?? null;
    }
  }

  return (
    <div>
      <PageHead
        eyebrow="PAC Africa · Internal"
        title={dash.admin.applicationsTitle}
        sub={dash.admin.applicationsSub}
        action={
          <Link href={exportHref(params)} className="btn-secondary text-xs">
            <Download className="h-3.5 w-3.5" aria-hidden />
            Export CSV
          </Link>
        }
      />

      {/* SEARCH ------------------------------------------------------- */}
      <form action="/admin/applications" className="flex flex-col sm:flex-row gap-2.5 mt-6">
        <div className="relative flex-1">
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint"
            aria-hidden
          />
          <label htmlFor="q" className="sr-only">
            Search by name, email or role
          </label>
          <input
            id="q"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Name, email address, or the role they applied for"
            className="field pl-10"
          />
        </div>
        {/* Chip state lives in the URL, so it must survive a search submit. */}
        {params.status && <input type="hidden" name="status" value={params.status} />}
        {params.source && <input type="hidden" name="source" value={params.source} />}
        {params.cv && <input type="hidden" name="cv" value={params.cv} />}
        {params.claimed && <input type="hidden" name="claimed" value={params.claimed} />}
        {params.year && <input type="hidden" name="year" value={params.year} />}
        {params.employer && (
          <input type="hidden" name="employer" value={params.employer} />
        )}
        <button type="submit" className="btn-primary shrink-0">
          Search
        </button>
      </form>

      {/* Year and employer are selects rather than chips — 12 years and a
          growing employer list would swamp the chip row. */}
      <form action="/admin/applications" className="mt-3 flex flex-wrap items-end gap-2">
        {params.q && <input type="hidden" name="q" value={params.q} />}
        {params.status && <input type="hidden" name="status" value={params.status} />}
        {params.source && <input type="hidden" name="source" value={params.source} />}
        {params.cv && <input type="hidden" name="cv" value={params.cv} />}
        {params.claimed && <input type="hidden" name="claimed" value={params.claimed} />}

        <div>
          <label htmlFor="year" className="eyebrow mb-1.5 block">
            Year applied
          </label>
          <select
            id="year"
            name="year"
            defaultValue={params.year ?? ""}
            className="field w-[150px]"
          >
            <option value="">Any year</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="employer" className="eyebrow mb-1.5 block">
            Employer
          </label>
          <select
            id="employer"
            name="employer"
            defaultValue={params.employer ?? ""}
            className="field w-[220px]"
          >
            <option value="">Any employer</option>
            {employers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="btn-secondary text-xs">
          Apply
        </button>
      </form>

      {/* FILTERS ------------------------------------------------------ */}
      <div className="flex flex-wrap items-start gap-4 mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip label="All" active={!params.status} to={href(params, { status: null, page: null, id: null })} />
        {STATUSES.filter((s) => s !== "rejected" && s !== "hired").map((s) => (
          <FilterChip
            key={s}
            label={s}
            active={params.status === s}
            to={href(params, { status: s, page: null, id: null })}
          />
        ))}
        <span className="w-px h-5 bg-line mx-1" aria-hidden />
        <FilterChip
          label="Below requirements"
          active={params.meets === "0"}
          to={href(params, {
            meets: params.meets === "0" ? null : "0",
            page: null,
            id: null,
          })}
        />
        <FilterChip
          label="Meets requirements"
          active={params.meets === "1"}
          to={href(params, {
            meets: params.meets === "1" ? null : "1",
            page: null,
            id: null,
          })}
        />
        <span className="w-px h-5 bg-line mx-1" aria-hidden />
        <FilterChip
          label="Not reviewed"
          active={params.review === "unreviewed"}
          to={href(params, {
            review: params.review === "unreviewed" ? null : "unreviewed",
            page: null,
            id: null,
          })}
        />
        <FilterChip
          label="Seen"
          active={params.review === "seen"}
          to={href(params, {
            review: params.review === "seen" ? null : "seen",
            page: null,
            id: null,
          })}
        />
        <FilterChip
          label="Final reviewed"
          active={params.review === "final"}
          to={href(params, {
            review: params.review === "final" ? null : "final",
            page: null,
            id: null,
          })}
        />

        {(params.q ||
          params.status ||
          params.source ||
          params.cv ||
          params.claimed ||
          params.review ||
          params.year ||
          params.employer) && (
          <Link href="/admin/applications" className="btn-ghost ml-auto text-xs">
            Clear all
          </Link>
        )}
      </div>

      <MoreFiltersPanel params={params} />
      </div>

      <div className="flex items-baseline justify-between gap-4 mt-6 mb-3">
        <p className="text-sm text-muted">
          {total.toLocaleString()} application{total === 1 ? "" : "s"}
          {total > 0 && (
            <>
              {" "}
              &middot; page {page} of {lastPage}
            </>
          )}
        </p>
        <Pager params={params} page={page} lastPage={lastPage} />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body="Try a shorter search term, or clear the filters."
          action={
            <Link href="/admin/applications" className="btn-secondary">
              Clear filters
            </Link>
          }
        />
      ) : (
        <ul className="clay divide-y divide-line">
          {rows.map((row) => {
            const role = row.job?.title ?? row.wp_job_title;

            return (
              <li key={row.id} className="relative p-4 transition-colors duration-150 hover:bg-surface-raised/50">
                {/* Stretched over the row, under the contact links and CV link,
                    which are separate destinations and stay clickable. */}
                <Link
                  href={href(params, { id: row.id })}
                  scroll={false}
                  aria-label={displayApplicant(row.applicant_name, row.applicant_email)}
                  className="absolute inset-0 z-0"
                />
                <div className="pointer-events-none relative z-[1] flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-500 text-ink">
                      {displayApplicant(row.applicant_name, row.applicant_email)}
                      {row.wp_post_id !== null && (
                        <span className="eyebrow ml-2">archive</span>
                      )}
                    </p>
                    <p className="pointer-events-auto mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <a
                        href={`mailto:${row.applicant_email}`}
                        className="inline-flex items-center gap-1 hover:text-accent-text"
                      >
                        <Mail className="w-3.5 h-3.5" aria-hidden />
                        {row.applicant_email}
                      </a>
                      {row.applicant_phone && (
                        <a
                          href={`tel:${row.applicant_phone.replace(/\s+/g, "")}`}
                          className="inline-flex items-center gap-1 hover:text-accent-text"
                        >
                          <Phone className="w-3.5 h-3.5" aria-hidden />
                          {row.applicant_phone}
                        </a>
                      )}
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {role ? (
                        row.job ? (
                          <Link
                            href={`/jobs/${row.job.slug}`}
                            className="hover:text-accent-text"
                          >
                            {role}
                          </Link>
                        ) : (
                          role
                        )
                      ) : (
                        <span className="text-faint">Role not recorded</span>
                      )}
                      {" · "}
                      {new Date(row.applied_at).toLocaleDateString("en-KE", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {row.applicant_id === null && row.wp_post_id !== null && (
                        <span className="text-faint"> · unclaimed</span>
                      )}
                    </p>
                  </div>

                  <div className="pointer-events-auto flex shrink-0 items-center gap-3">
                    <CvLink
                      status={cvStatus(row.cv_url)}
                      onOpen={signApplicationCv.bind(null, row.id)}
                      compact
                    />
                    {(() => {
                      const rs = reviewSummaryFor(reviews, row.id);
                      return (
                        <ReviewStatusBadge
                          finalBy={rs.final?.reviewerName ?? null}
                          overviewCount={rs.overviews.length}
                        />
                      );
                    })()}
                    <RequirementsBadge meets={row.meets_requirements} />
                    <StatusSelect
                      applicationId={row.id}
                      current={row.status}
                      returnTo={href(params, {})}
                      action={setApplicationStatusAdmin}
                    />
                  </div>
                </div>

              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-muted">
          Showing {rows.length === 0 ? 0 : from + 1}–{from + rows.length} of{" "}
          {total.toLocaleString()}
        </p>
        <Pager params={params} page={page} lastPage={lastPage} />
      </div>

      <Drawer
        open={Boolean(detail)}
        closeHref={href(params, { id: null })}
        title={
          detail
            ? displayApplicant(detail.applicant_name, detail.applicant_email)
            : dash.admin.applicationsTitle
        }
      >
        {detail && (
          <ApplicationDetailBody
            application={detail}
            events={events}
            cv={{
              status: drawerCvStatus,
              onOpen: openId ? signApplicationCv.bind(null, openId) : undefined,
            }}
            avatarSrc={drawerCard?.avatarSrc}
            showContact
            showNote
            profileDetail={profileDetail}
            statusControl={
              <StatusSelect
                applicationId={detail.id}
                current={detail.status}
                returnTo={returnTo}
                action={setApplicationStatusAdmin}
              />
            }
            noteControl={
              <NoteForm
                applicationId={detail.id}
                current={detail.employer_note}
                returnTo={returnTo}
                action={setApplicationStatusAdmin}
              />
            }
            reviewPanel={
              <ReviewPanel
                applicationId={detail.id}
                returnTo={returnTo}
                currentUserId={userId}
                summary={reviewSummaryFor(reviews, detail.id)}
              />
            }
          />
        )}
      </Drawer>

      <ToastFromSearchParams
        error={error?.message}
        success={
          params.updated === "status"
            ? dash.drawer.statusUpdated
            : params.updated === "note"
              ? "Note saved."
              : params.reviewed === "final"
                ? "Final review recorded."
                : params.reviewed === "overview"
                  ? "Marked as seen."
                  : null
        }
      />
    </div>
  );
}

function FilterChip({
  label,
  active,
  to,
}: {
  label: string;
  active: boolean;
  to: string;
}) {
  return (
    <Link href={to} className={`chip ${active ? "chip-active" : ""} capitalize`}>
      {label}
    </Link>
  );
}

function MoreFiltersPanel({ params }: { params: Params }) {
  const hasHiddenFilter =
    params.status === "rejected" ||
    params.status === "hired" ||
    Boolean(params.source) ||
    Boolean(params.cv) ||
    Boolean(params.claimed);

  return (
    <details className="clay group p-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-ink">
        <SlidersHorizontal className="h-4 w-4" aria-hidden />
        More filters
        {hasHiddenFilter && (
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
        )}
      </summary>
      <div className="relative">
        <div className="clay absolute left-0 top-2 z-10 w-72 space-y-6 p-5 shadow-clay-lifted">
          <FilterGroup title="Status">
            <ChipLink
              label="rejected"
              active={params.status === "rejected"}
              to={href(params, { status: params.status === "rejected" ? null : "rejected", page: null, id: null })}
            />
            <ChipLink
              label="hired"
              active={params.status === "hired"}
              to={href(params, { status: params.status === "hired" ? null : "hired", page: null, id: null })}
            />
          </FilterGroup>
          <FilterGroup title="Source">
            <ChipLink
              label="Archive"
              active={params.source === "historical"}
              to={href(params, {
                source: params.source === "historical" ? null : "historical",
                page: null,
                id: null,
              })}
            />
            <ChipLink
              label="Since relaunch"
              active={params.source === "new"}
              to={href(params, { source: params.source === "new" ? null : "new", page: null, id: null })}
            />
          </FilterGroup>
          <FilterGroup title="CV">
            <ChipLink
              label="CV on old site"
              active={params.cv === "legacy"}
              to={href(params, { cv: params.cv === "legacy" ? null : "legacy", page: null, id: null })}
            />
            <ChipLink
              label="CV migrated"
              active={params.cv === "migrated"}
              to={href(params, { cv: params.cv === "migrated" ? null : "migrated", page: null, id: null })}
            />
            <ChipLink
              label="No CV"
              active={params.cv === "none"}
              to={href(params, { cv: params.cv === "none" ? null : "none", page: null, id: null })}
            />
          </FilterGroup>
          {/* Every archive row starts unclaimed, so this is how you find who has
              come back and reconnected their history. */}
          <FilterGroup title="Claimed">
            <ChipLink
              label="Claimed"
              active={params.claimed === "yes"}
              to={href(params, {
                claimed: params.claimed === "yes" ? null : "yes",
                page: null,
                id: null,
              })}
            />
            <ChipLink
              label="Unclaimed"
              active={params.claimed === "no"}
              to={href(params, {
                claimed: params.claimed === "no" ? null : "no",
                page: null,
                id: null,
              })}
            />
          </FilterGroup>
        </div>
      </div>
    </details>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="eyebrow mb-2.5">{title}</h2>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function ChipLink({ label, active, to }: { label: string; active: boolean; to: string }) {
  return (
    <Link href={to} className={`chip ${active ? "chip-active" : ""} capitalize`}>
      {label}
    </Link>
  );
}

function Pager({
  params,
  page,
  lastPage,
}: {
  params: Params;
  page: number;
  lastPage: number;
}) {
  if (lastPage <= 1) return null;
  return (
    <div className="flex items-center gap-1.5">
      {page > 1 ? (
        <Link
          href={href(params, { page: page === 2 ? null : String(page - 1) })}
          className="btn-secondary px-2.5 py-1.5 text-xs"
        >
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden />
          Previous
        </Link>
      ) : (
        <span className="btn-secondary px-2.5 py-1.5 text-xs opacity-45 pointer-events-none">
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden />
          Previous
        </span>
      )}
      {page < lastPage ? (
        <Link
          href={href(params, { page: String(page + 1) })}
          className="btn-secondary px-2.5 py-1.5 text-xs"
        >
          Next
          <ChevronRight className="w-3.5 h-3.5" aria-hidden />
        </Link>
      ) : (
        <span className="btn-secondary px-2.5 py-1.5 text-xs opacity-45 pointer-events-none">
          Next
          <ChevronRight className="w-3.5 h-3.5" aria-hidden />
        </span>
      )}
    </div>
  );
}
