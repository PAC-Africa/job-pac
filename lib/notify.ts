import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email";
import { applicationStatusLabels, site } from "@/lib/content";
import type { ApplicationStatus, JobAlert } from "@/types/database";

type NotifiableProfile = { email: string; notify_email: boolean };

/**
 * Looks up who to notify for a job — the profile that posted it, falling
 * back to the owning company's profile. Always through the admin client:
 * `companies` and `profiles.email` aren't world-readable (migration 016),
 * and the caller here is sometimes a guest applicant's request with no
 * standing to read either. Carries `notify_email` (migration 028) alongside
 * the address so a caller can honour the recipient's own opt-out in one trip.
 */
async function employerProfileForJob(jobId: string): Promise<NotifiableProfile | null> {
  const admin = createAdminClient();

  const { data: job } = await admin
    .from("jobs")
    .select("posted_by, company_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return null;
  const row = job as { posted_by: string | null; company_id: string | null };

  if (row.posted_by) {
    const { data: p } = await admin
      .from("profiles")
      .select("email, notify_email")
      .eq("id", row.posted_by)
      .maybeSingle();
    if ((p as NotifiableProfile | null)?.email) return p as NotifiableProfile;
  }

  if (row.company_id) {
    const { data: c } = await admin
      .from("companies")
      .select("owner_id")
      .eq("id", row.company_id)
      .maybeSingle();
    const ownerId = (c as { owner_id: string | null } | null)?.owner_id;
    if (ownerId) {
      const { data: p } = await admin
        .from("profiles")
        .select("email, notify_email")
        .eq("id", ownerId)
        .maybeSingle();
      if ((p as NotifiableProfile | null)?.email) return p as NotifiableProfile;
    }
  }

  return null;
}

const link = (path: string) => `https://${site.domain}${path}`;

/** Trigger 1 — a new application landed on the employer's job. */
export async function notifyApplicationReceived(
  jobId: string,
  jobTitle: string,
  applicantName: string
): Promise<void> {
  const employer = await employerProfileForJob(jobId);
  if (!employer || !employer.notify_email) return;
  const to = employer.email;

  const url = link("/dashboard/employer/applications");
  await sendMail({
    to,
    subject: `New application: ${jobTitle}`,
    text: `${applicantName} just applied to ${jobTitle}.\n\nReview it: ${url}`,
    html: `<p>${applicantName} just applied to <strong>${jobTitle}</strong>.</p><p><a href="${url}">Review the application</a></p>`,
  });
}

/**
 * Trigger 1b — confirmation to the applicant themselves. Only meaningful for a
 * guest: a signed-in applicant already sees the application in their own
 * dashboard. The signup link carries their email so `claim_historical_applications`
 * (migration 006) picks this application up the moment they confirm an account.
 */
export async function notifyApplicantApplicationReceived(
  email: string,
  jobTitle: string
): Promise<void> {
  const url = link(`/auth/signup?email=${encodeURIComponent(email)}`);
  const body = `We've received your application for ${jobTitle}. The employer has been notified.`;

  await sendMail({
    to: email,
    subject: `Application received: ${jobTitle}`,
    text: `${body}\n\nCreate an account to track its status: ${url}`,
    html: `<p>${body}</p><p><a href="${url}">Create an account</a> to track its status.</p>`,
  });
}

/** Trigger 2 — a listing was approved or sent back by an admin. */
export async function notifyJobDecision(
  jobId: string,
  jobTitle: string,
  decision: "published" | "rejected",
  reason?: string | null
): Promise<void> {
  const employer = await employerProfileForJob(jobId);
  if (!employer || !employer.notify_email) return;
  const to = employer.email;

  const url = link("/dashboard/employer/jobs");
  const subject =
    decision === "published" ? `Your listing is live: ${jobTitle}` : `Changes needed: ${jobTitle}`;
  const body =
    decision === "published"
      ? `${jobTitle} is now live on PAC Africa Jobs.`
      : `${jobTitle} was sent back for changes.${reason ? ` Reason: ${reason}` : ""}`;

  await sendMail({
    to,
    subject,
    text: `${body}\n\nView your listings: ${url}`,
    html: `<p>${body}</p><p><a href="${url}">View your listings</a></p>`,
  });
}

/**
 * Trigger 3 — an employer moved an application to a new stage.
 *
 * A guest applicant has no profile row and so no opt-out to honour — this
 * only ever suppresses the email for a registered seeker who turned
 * `notify_email` off, matched by address since the caller doesn't carry
 * `applicant_id` (it isn't needed for anything else it does).
 */
export async function notifyApplicationStatusChanged(
  applicantEmail: string,
  jobTitle: string,
  status: ApplicationStatus
): Promise<void> {
  // "pending" is the starting state, never a transition worth emailing about.
  if (status === "pending") return;

  const admin = createAdminClient();
  const { data: seeker } = await admin
    .from("profiles")
    .select("notify_email")
    .eq("email", applicantEmail)
    .maybeSingle();
  if ((seeker as { notify_email: boolean } | null)?.notify_email === false) return;

  const label = applicationStatusLabels[status];
  const url = link("/dashboard/seeker/applications");
  const body = `Your application for ${jobTitle} is now: ${label}.`;

  await sendMail({
    to: applicantEmail,
    subject: `Update on your application: ${jobTitle}`,
    text: `${body}\n\nTrack it: ${url}`,
    html: `<p>${body}</p><p><a href="${url}">Track your application</a></p>`,
  });
}

/**
 * Trigger 4 — a new listing just went live, for every seeker who opted in.
 * Off by default (migration 028): this is the one trigger that can fan out to
 * an entire table rather than one recipient, so it stays opt-in rather than
 * inheriting `notify_email`, which governs the seeker's own application
 * activity, not other people's job postings.
 */
export async function notifyNewJobSubscribers(jobTitle: string): Promise<void> {
  const admin = createAdminClient();
  const { data: subscribers } = await admin
    .from("profiles")
    .select("email")
    .eq("role", "seeker")
    .eq("notify_new_jobs", true);

  const rows = (subscribers as { email: string }[] | null) ?? [];
  if (rows.length === 0) return;

  const url = link("/jobs");
  const body = `A new role just went live: ${jobTitle}.`;

  // Fire-and-forget in parallel — each is its own fail-soft send (lib/email.ts),
  // so one bad address never stops the rest of the batch.
  await Promise.all(
    rows.map((row) =>
      sendMail({
        to: row.email,
        subject: `New job posted: ${jobTitle}`,
        text: `${body}\n\nHave a look: ${url}`,
        html: `<p>${body}</p><p><a href="${url}">Have a look</a></p>`,
      })
    )
  );
}

/**
 * Trigger 5 — a listing entered the review queue. Goes to the shared
 * hello@pac.africa inbox rather than every admin individually — there are
 * several admins, and a per-person email for every new listing floods each
 * of their inboxes for something one person acting on the shared queue
 * already resolves for everyone else.
 */
export async function notifyAdminPendingReview(jobTitle: string): Promise<void> {
  const url = link("/admin/moderation");
  const body = `${jobTitle} is waiting for review.`;

  await sendMail({
    to: "hello@pac.africa",
    subject: `Review needed: ${jobTitle}`,
    text: `${body}\n\nReview it: ${url}`,
    html: `<p>${body}</p><p><a href="${url}">Review it</a></p>`,
  });
}

type AlertJob = {
  id: string;
  title: string;
  slug: string;
  category_id: string | null;
  location_id: string | null;
  job_type: string | null;
  created_at: string;
};

/**
 * Trigger 6 — job alerts digest. Called once a day by the Vercel Cron in
 * vercel.json, via app/api/cron/job-alerts/route.ts.
 *
 * `job_alerts` and its CRUD UI (app/dashboard/seeker/alerts/) already
 * existed; this is the missing half that makes an alert do something. One
 * query for all active alerts, one for the widest possible window of
 * published jobs (7 days — the longest any alert's frequency needs), then
 * matched in memory per alert rather than one job query per alert.
 *
 * `last_sent_at` doubles as "last processed", not just "last emailed" — it
 * advances every run regardless of match count so a daily alert's window
 * never gaps or double-counts. A weekly alert not yet due this run is left
 * untouched entirely, so its window keeps accumulating toward the next send.
 */
export async function runJobAlertDigest(): Promise<void> {
  const admin = createAdminClient();
  const now = Date.now();

  const { data: alertRows } = await admin
    .from("job_alerts")
    .select("*")
    .eq("is_active", true);
  const alerts = (alertRows as JobAlert[] | null) ?? [];
  if (alerts.length === 0) return;

  const since = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: jobRows } = await admin
    .from("jobs")
    .select("id, title, slug, category_id, location_id, job_type, created_at")
    .eq("status", "published")
    .gte("created_at", since);
  const jobs = (jobRows as AlertJob[] | null) ?? [];

  for (const alert of alerts) {
    const isWeekly = alert.frequency === "weekly";
    const windowMs = (isWeekly ? 7 : 1) * 24 * 60 * 60 * 1000;
    const lastSent = alert.last_sent_at ? new Date(alert.last_sent_at).getTime() : null;

    if (isWeekly && lastSent !== null && now - lastSent < windowMs) {
      continue; // Not due yet — last_sent_at stays as-is.
    }

    const windowStart = lastSent ?? now - windowMs;
    let matches = jobs.filter((job) => {
      if (new Date(job.created_at).getTime() < windowStart) return false;
      if (alert.category_id && job.category_id !== alert.category_id) return false;
      if (alert.location_id && job.location_id !== alert.location_id) return false;
      if (alert.job_type && job.job_type !== alert.job_type) return false;
      return true;
    });

    if (alert.keyword && matches.length > 0) {
      // The pre-filtered batch above is at most a week of published jobs, so
      // a text-search call per keyword alert is cheap — no need to pull fts
      // into memory to match it by hand.
      const ids = matches.map((j) => j.id);
      const { data: searched } = await admin
        .from("jobs")
        .select("id")
        .in("id", ids)
        .textSearch("fts", alert.keyword, { type: "websearch" });
      const keep = new Set(((searched as { id: string }[] | null) ?? []).map((r) => r.id));
      matches = matches.filter((j) => keep.has(j.id));
    }

    if (matches.length > 0) {
      const text = matches.map((j) => `- ${j.title}: ${link(`/jobs/${j.slug}`)}`).join("\n");
      const html = matches
        .map((j) => `<li><a href="${link(`/jobs/${j.slug}`)}">${j.title}</a></li>`)
        .join("");
      await sendMail({
        to: alert.email,
        subject:
          matches.length === 1 ? `New job match: ${matches[0].title}` : `${matches.length} new job matches`,
        text: `New roles matching your alert:\n\n${text}`,
        html: `<p>New roles matching your alert:</p><ul>${html}</ul>`,
      });
    }

    await admin
      .from("job_alerts")
      .update({ last_sent_at: new Date(now).toISOString() })
      .eq("id", alert.id);
  }
}
