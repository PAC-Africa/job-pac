"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, dashboardPathFor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { navFor } from "@/lib/dashboard-nav";
import { dash } from "@/lib/content";
import type { Profile } from "@/types/database";

/**
 * Password change from Settings.
 *
 * `updateUser` rather than the emailed recovery flow: the person is already
 * authenticated, so posting a link to their inbox adds a round trip and a token
 * to leak without proving anything the session has not already proved.
 *
 * 10 characters rather than the 8 the signup form asks for. Supabase's
 * leaked-password check (HaveIBeenPwned) is the other half of this and is a
 * project setting, not something this code can turn on.
 */
export async function changePassword(formData: FormData) {
  const { supabase, profile } = await requireUser();
  const base = `${dashboardPathFor(profile.role)}/settings`;
  const fail = (message: string) =>
    redirect(`${base}?error=${encodeURIComponent(message)}`);

  const password = formData.get("password");
  const confirm = formData.get("password_confirm");

  if (typeof password !== "string" || password.length < 10) {
    fail(dash.settings.passwordTooShort);
  }
  if (password !== confirm) fail(dash.settings.passwordMismatch);

  const { error } = await supabase.auth.updateUser({ password: password as string });
  if (error) fail(error.message);

  redirect(`${base}?updated=password`);
}

/**
 * Notification preferences (migration 028) — checkboxes, so an unchecked box
 * simply doesn't appear in the form body. `formData.has()` is the only way to
 * tell "off" apart from "field not rendered for this role" at all, which is
 * why each column is only ever written when its own checkbox was present.
 */
export async function updateNotificationPrefs(formData: FormData) {
  const { supabase, profile } = await requireUser();
  const base = `${dashboardPathFor(profile.role)}/settings`;

  const patch: Partial<Pick<Profile, "notify_email" | "notify_new_jobs">> = {};
  if (formData.has("notify_email_field")) {
    patch.notify_email = formData.get("notify_email") === "on";
  }
  if (formData.has("notify_new_jobs_field")) {
    patch.notify_new_jobs = formData.get("notify_new_jobs") === "on";
  }

  if (Object.keys(patch).length === 0) redirect(base);

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", profile.id);

  if (error) redirect(`${base}?error=${encodeURIComponent(error.message)}`);

  redirect(`${base}?updated=notifications`);
}

/**
 * Dashboard personalization (migration 030).
 *
 * `dashboard_landing` is re-validated against this role's own nav here, at
 * write time, rather than trusted at read time in app/dashboard/page.tsx —
 * the same boundary safeNextPath already applies to a "next" query param. A
 * value that doesn't match one of this role's real hrefs is silently
 * dropped to null (falls back to the ordinary per-role dashboard) rather
 * than rejected with an error, since it can only arrive here as an unusual
 * form submission, not a plausible user mistake.
 */
export async function updateDashboardPrefs(formData: FormData) {
  const { supabase, profile } = await requireUser();
  const base = `${dashboardPathFor(profile.role)}/settings`;

  const landing = formData.get("dashboard_landing");
  const validLanding =
    typeof landing === "string" && navFor(profile.role).some((item) => item.href === landing)
      ? landing
      : null;

  const density = formData.get("dashboard_density") === "compact" ? "compact" : "comfortable";

  const { error } = await supabase
    .from("profiles")
    .update({ dashboard_landing: validLanding, dashboard_density: density })
    .eq("id", profile.id);

  if (error) redirect(`${base}?error=${encodeURIComponent(error.message)}`);

  revalidatePath("/dashboard", "layout");
  redirect(`${base}?updated=preferences`);
}

/**
 * Seeker self-service account deletion. Employer/admin still use the mailto
 * in components/settings-panel.tsx — deleting an employer cascades into their
 * jobs and other seekers' applications to those jobs, a different, harder
 * policy question that hasn't been decided yet.
 *
 * Order matters: applications.applicant_id is ON DELETE SET NULL (not
 * cascade, by design — the application itself survives), so the PII on the
 * applicant's own rows has to be scrubbed first, while applicant_id can still
 * find them. profiles.id is ON DELETE CASCADE from auth.users, which also
 * cascades to saved_jobs and job_alerts — deleteUser() alone cleans those up.
 *
 * applicant_email is NOT NULL and carries a unique(job_id, lower(email))
 * index (migration 013), so it's replaced with a per-row placeholder rather
 * than a shared one, which would collide across rows on the same job.
 */
export async function deleteSeekerAccount() {
  const { profile } = await requireUser();
  if (profile.role !== "seeker") redirect(`${dashboardPathFor(profile.role)}/settings`);

  const admin = createAdminClient();

  const { data: applications } = await admin
    .from("applications")
    .select("id")
    .eq("applicant_id", profile.id);

  for (const application of (applications as { id: string }[] | null) ?? []) {
    await admin
      .from("applications")
      .update({
        applicant_name: "Deleted user",
        applicant_email: `deleted-${application.id}@deleted.pac.africa`,
        applicant_phone: null,
        cover_letter: null,
        cv_url: null,
      })
      .eq("id", application.id);
  }

  const { error } = await admin.auth.admin.deleteUser(profile.id);
  if (error) {
    redirect(`${dashboardPathFor("seeker")}/settings?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/auth/account-deleted");
}
