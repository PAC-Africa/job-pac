"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  CV_ACCEPT,
  CV_BUCKET,
  CV_MAX_BYTES,
  cvObjectPath,
  isLegacyCvUrl,
  looksLikePdf,
} from "@/lib/cv";
import { UNIQUE_VIOLATION } from "@/lib/job-form";
import { checkRateLimit } from "@/lib/rate-limit";
import { notifyApplicationReceived, notifyApplicantApplicationReceived } from "@/lib/notify";
import { dataConsent } from "@/lib/content";
import { isProfileGateComplete } from "@/lib/profile";
import { hasHiringProfileEntries } from "@/lib/auth";
import type { EducationLevel } from "@/types/database";

/**
 * Submitting an application.
 *
 * This used to happen in the browser: the apply form held the anon key and wrote
 * to `applications` and to storage directly. That made both an open,
 * unauthenticated write endpoint that no rate limit could reach, because the
 * request went to Supabase and never passed through our own origin. Migration
 * 024 removed the anonymous grants; this action is the replacement path.
 *
 * Two routes through it, on purpose:
 *
 *   signed in → the caller's own client, so the RLS policy still enforces that
 *               `applicant_id = auth.uid()`. The database, not this file, is
 *               what guarantees you cannot file an application as someone else.
 *   guest     → the service role, via a `security definer` function that fixes
 *               the column list and forces `applicant_id` to null.
 *
 * Being a server action also means every submission is a POST to this origin, so
 * the Vercel rate limit on /jobs/* applies to it — which was the whole point.
 */

const HONEYPOT = "website";

/**
 * Sends the visitor back to the listing with a CODE, never a message.
 *
 * Passing the sentence itself let anyone put arbitrary copy inside the apply
 * card on a genuine listing URL — no login, no interaction beyond clicking a
 * link. React escaped it so it was never XSS, but "email your CV and ID to
 * verify@…" rendered inside the widget people upload identity documents to is a
 * usable phishing primitive. The codes resolve against gate.applyErrors on
 * render and anything unrecognised shows nothing.
 */
type ApplyError =
  | "invalid_request"
  | "closed"
  | "signed_out"
  | "not_seeker"
  | "name_required"
  | "email_invalid"
  | "cv_too_large"
  | "cv_not_pdf"
  | "cv_upload_failed"
  | "duplicate"
  | "rate_limited"
  | "phone_invalid"
  | "experience_required"
  | "consent_required"
  | "failed";

function fail(slug: string, code: ApplyError): never {
  redirect(`/jobs/${slug}?apply_error=${code}`);
}

function text(formData: FormData, key: string, max: number): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Truncated rather than rejected: a pasted cover letter running long is not a
  // mistake worth throwing an application away over. The columns are `text`, so
  // this is about keeping one submission from carrying a megabyte of prose.
  return trimmed.slice(0, max);
}

/** Non-negative integer or null — used for the years-of-experience/salary
 * snapshot fields (migration 033), which are required but still validated
 * gracefully rather than throwing on a malformed value. */
function positiveInt(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Lenient on purpose: digits, spaces, dashes, parentheses and an optional
// leading +, 7–20 characters. Real numbers arrive in enough different
// notations (+254 7xx xxx xxx, (020) xxx-xxxx, etc.) that a strict E.164-only
// pattern would reject genuine applicants. This only had to catch "not a
// phone number at all" — previously nothing did, up to the 40-char cap.
// The lookahead requires at least one digit — without it a string of pure
// punctuation like "-------" matched too.
const PHONE = /^(?=.*[0-9])[+]?[0-9()\-\s]{7,20}$/;

export async function submitApplication(formData: FormData) {
  const slugRaw = formData.get("slug");
  const slug = typeof slugRaw === "string" ? slugRaw : "";
  if (!slug) redirect("/jobs");

  // ── Honeypot ───────────────────────────────────────────────
  // A field no human sees and no human fills. Returns the success path rather
  // than an error, so a bot cannot tell it has been caught and try again with
  // the field left blank.
  if (text(formData, HONEYPOT, 200)) {
    redirect(`/jobs/${slug}?applied=1`);
  }

  // ── Rate limit ─────────────────────────────────────────────
  // Generous on purpose — see migrations/026_apply_rate_limit.sql for why 8
  // per 15 minutes, hashed per IP, is meant to catch a script rather than a
  // shared connection.
  if (!(await checkRateLimit("apply", 8, 900))) {
    fail(slug, "rate_limited");
  }

  const supabase = await createClient();

  // ── Who is applying ────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let viewerEmail: string | null = null;
  let profileCvUrl: string | null = null;

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select(
        "role, cv_url, suspended_at, full_name, phone, years_experience, education_level, industry_category_id, skills"
      )
      .eq("id", user.id)
      .single();

    if (!profile) fail(slug, "signed_out");
    const p = profile as {
      role: string;
      cv_url: string | null;
      suspended_at: string | null;
      full_name: string | null;
      phone: string | null;
      years_experience: number | null;
      education_level: EducationLevel | null;
      industry_category_id: string | null;
      skills: string[] | null;
    };

    // Both are also enforced in the database (migration 022 for suspension, the
    // role gate by the seeker-only insert policy). Checked here so the applicant
    // gets a sentence rather than a constraint violation.
    if (p.suspended_at) redirect("/auth/suspended");
    if (p.role !== "seeker") {
      fail(slug, "not_seeker");
    }

    // Same gate as Saved/Alerts/Applications (lib/auth.ts
    // requireCompleteSeekerProfile) — a signed-in seeker with an unfinished
    // profile is sent to finish it instead of applying with, e.g., no CV.
    // Guests skip this entirely; they have no profile to gate.
    const hasCv = Boolean(p.cv_url) && !isLegacyCvUrl(p.cv_url);
    const [hasEducation, hasWorkExperience] = await hasHiringProfileEntries(
      supabase,
      user.id
    );
    if (!isProfileGateComplete(p, hasCv, hasEducation, hasWorkExperience)) {
      redirect("/dashboard/seeker/profile?locked=apply");
    }

    // From auth.users via the verified session, NOT from profiles.email.
    // profiles.email is a column its owner can write, so reading it here meant a
    // signed-in user could file an application under a third party's address by
    // PATCHing their own profile first. Migration 025 now blocks that write too,
    // but the address should never have come from a rewritable place.
    viewerEmail = user.email ?? null;
    profileCvUrl = p.cv_url;
  }

  // ── The job ────────────────────────────────────────────────
  // Read through the caller's client, so only a published listing resolves —
  // `jobs_select_published` is doing the work, and a draft or paused role is
  // simply not found.
  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, status")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (!job) fail(slug, "closed");
  const jobRow = job as { id: string; title: string };

  // ── The fields ─────────────────────────────────────────────
  const name = text(formData, "applicant_name", 120);
  // A signed-in applicant files under their account address. Identity and the
  // claim-history flow both key on it, so it is never read from the form —
  // otherwise anyone could file an application against someone else's address
  // while logged in.
  const email = user ? viewerEmail : text(formData, "applicant_email", 160);
  const phone = text(formData, "applicant_phone", 40);
  const cover = text(formData, "cover_letter", 8000);

  if (!name) fail(slug, "name_required");
  if (!email || !EMAIL.test(email)) fail(slug, "email_invalid");
  if (phone && !PHONE.test(phone)) fail(slug, "phone_invalid");

  // ── Experience/salary snapshot (migration 033) ────────────────
  // Required at the form layer (components/apply-form.tsx marks them
  // required), re-checked here since that's a UI convenience, not the gate.
  const yearsExperience = positiveInt(formData, "years_experience");
  const expectedSalary = positiveInt(formData, "expected_salary");
  const currentSalary = positiveInt(formData, "current_salary");
  if (yearsExperience === null || expectedSalary === null || currentSalary === null) {
    fail(slug, "experience_required");
  }

  // ── Data consent (migration 033) ──────────────────────────────
  // The checkbox in components/consent-clause.tsx is the UX; this is the
  // actual gate — a request with no `consent` field, scripted or otherwise,
  // is rejected regardless of what the client-side scroll gate allowed.
  if (formData.get("consent") !== "on") {
    fail(slug, "consent_required");
  }
  const consentedAt = new Date().toISOString();
  const consentVersion = dataConsent.version;

  // ── The CV ─────────────────────────────────────────────────
  const reuse = formData.get("reuse_cv") === "on";
  const file = formData.get("cv");
  const upload = file instanceof File && file.size > 0 ? file : null;

  let cvPath: string | null = null;

  if (reuse && profileCvUrl && !isLegacyCvUrl(profileCvUrl)) {
    // Same bucket, same object — reference it rather than copying bytes.
    cvPath = profileCvUrl;
  } else if (upload) {
    if (upload.size > CV_MAX_BYTES) fail(slug, "cv_too_large");
    // The declared content type is whatever the client claimed, so read the
    // bytes. This check could be skipped in the browser; here it cannot.
    if (!(await looksLikePdf(upload))) {
      fail(slug, "cv_not_pdf");
    }

    const path = cvObjectPath(upload.name);
    // A guest has no INSERT on the bucket any more (migration 024), so their
    // upload goes through the service role. A signed-in applicant uses their own
    // session, and the bucket policy applies.
    const storage = user ? supabase : createAdminClient();
    const { error: uploadError } = await storage.storage
      .from(CV_BUCKET)
      .upload(path, upload, { contentType: CV_ACCEPT, upsert: false });

    if (uploadError) {
      fail(slug, "cv_upload_failed");
    }
    cvPath = path;
  }

  // ── Write it ───────────────────────────────────────────────
  let duplicate = false;
  if (user) {
    // Under RLS: the policy requires applicant_id = auth.uid(), so this cannot
    // be filed on anyone else's behalf regardless of what the form said.
    const { error } = await supabase.from("applications").insert({
      job_id: jobRow.id,
      applicant_id: user.id,
      applicant_name: name,
      applicant_email: email,
      applicant_phone: phone,
      cover_letter: cover,
      cv_url: cvPath,
      wp_job_title: jobRow.title,
      status: "pending" as const,
      years_experience: yearsExperience,
      expected_salary: expectedSalary,
      current_salary: currentSalary,
      consented_at: consentedAt,
      consent_version: consentVersion,
    });

    if (error) {
      // Safe to be specific here: it is the caller's own application.
      fail(slug, error.code === UNIQUE_VIOLATION ? "duplicate" : "failed");
    }
  } else {
    const admin = createAdminClient();
    const { error } = await admin.rpc("submit_guest_application", {
      p_job_id: jobRow.id,
      p_name: name,
      p_email: email,
      p_phone: phone,
      p_cover_letter: cover,
      p_cv_url: cvPath,
      p_job_title: jobRow.title,
      p_years_experience: yearsExperience,
      p_expected_salary: expectedSalary,
      p_current_salary: currentSalary,
      p_consented_at: consentedAt,
      p_consent_version: consentVersion,
    });

    if (error) {
      // The partial unique index from migration 013 catches a repeat. Saying so
      // out loud would be an unauthenticated oracle: anyone could POST an
      // address they do not own against a live listing and read the answer off
      // the redirect — "has this named person applied to this employer" — which
      // is precisely the fact this product exists to keep private. So a
      // duplicate takes the success path, for the same reason the honeypot
      // above does. The real applicant is unaffected; their row already exists.
      duplicate =
        error.code === UNIQUE_VIOLATION ||
        /duplicate key|already exists/i.test(error.message);
      if (!duplicate) fail(slug, "failed");
    }
  }

  // A duplicate hit means no row was actually written — see above — so
  // notifying the employer here would announce an application that never
  // arrived.
  if (!duplicate) {
    await notifyApplicationReceived(jobRow.id, jobRow.title, name);
    // Signed-in applicants already see this in their dashboard; only a guest
    // needs the confirmation + account-creation nudge.
    if (!user) await notifyApplicantApplicationReceived(email, jobRow.title);
  }

  revalidatePath(`/jobs/${slug}`);
  if (user) revalidatePath("/dashboard/seeker");
  redirect(`/jobs/${slug}?applied=1`);
}
