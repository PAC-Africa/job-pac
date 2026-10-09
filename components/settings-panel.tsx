import Link from "next/link";
import { Download, Shield, Trash2 } from "lucide-react";
import { ToastFromSearchParams } from "@/components/toast-from-search-params";
import { AppearancePicker } from "@/components/appearance-picker";
import { ConfirmAction } from "@/components/confirm-action";
import { dash, site } from "@/lib/content";
import { navFor, roleLabel } from "@/lib/dashboard-nav";
import {
  changePassword,
  deleteSeekerAccount,
  updateDashboardPrefs,
  updateNotificationPrefs,
} from "@/app/dashboard/settings-actions";
import type { Profile } from "@/types/database";

/**
 * Settings, shared by all three roles.
 *
 * Only things that actually work are on here. The notification toggles below
 * gate real sends in lib/notify.ts (migration 028) — each one is checked
 * before the email it names ever goes out, so switching it off is never a
 * promise the product doesn't keep.
 *
 * The data section exists because this product holds CVs and contact details for
 * thousands of people, and the Kenya Data Protection Act 2019 gives them the
 * right to a copy and to erasure. Export is a route handler; deletion is a
 * mailed request, because it needs a human to decide what an employer must keep.
 */
export function SettingsPanel({
  profile,
  updated,
  error,
  exportHref,
}: {
  profile: Profile;
  updated?: string;
  error?: string;
  /** Omitted for admins, whose own data is not the point of an export. */
  exportHref?: string;
}) {
  return (
    <div className="max-w-2xl space-y-6">
      <ToastFromSearchParams
        error={error}
        success={
          updated === "password"
            ? dash.settings.passwordChanged
            : updated === "notifications"
              ? dash.settings.notificationsChanged
              : updated === "preferences"
                ? dash.settings.personalizationChanged
                : null
        }
      />

      {/* ACCOUNT ------------------------------------------------------ */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.accountTitle}
        </h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="eyebrow">{dash.settings.email}</dt>
            <dd className="mt-1 text-ink">{profile.email}</dd>
            <dd className="mt-1 text-xs text-muted">{dash.settings.emailHint}</dd>
          </div>
          <div>
            <dt className="eyebrow">{dash.settings.role}</dt>
            <dd className="mt-1 text-ink">{roleLabel[profile.role]}</dd>
          </div>
          <div>
            <dt className="eyebrow">{dash.settings.joined}</dt>
            <dd className="mt-1 text-ink">
              {new Date(profile.created_at).toLocaleDateString("en-KE", {
                month: "long",
                year: "numeric",
              })}
            </dd>
          </div>
        </dl>
      </section>

      {/* APPEARANCE ----------------------------------------------------- */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.appearanceTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{dash.settings.appearanceHint}</p>
        <AppearancePicker className="mt-4" />
      </section>

      {/* PERSONALIZATION ------------------------------------------------ */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.personalizationTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{dash.settings.personalizationHint}</p>
        <form action={updateDashboardPrefs} className="mt-4 space-y-4">
          <div>
            <label htmlFor="dashboard_landing" className="eyebrow mb-2 block">
              {dash.settings.landingLabel}
            </label>
            <select
              id="dashboard_landing"
              name="dashboard_landing"
              defaultValue={profile.dashboard_landing ?? ""}
              className="field"
            >
              <option value="">{dash.settings.landingDefault}</option>
              {navFor(profile.role)
                .filter((item) => !item.external)
                .map((item) => (
                  <option key={item.href} value={item.href}>
                    {item.label}
                  </option>
                ))}
            </select>
            <p className="mt-1.5 text-xs text-muted">{dash.settings.landingHint}</p>
          </div>

          <div>
            <span className="eyebrow mb-2 block">{dash.settings.densityLabel}</span>
            <div className="flex gap-2">
              <label className="flex-1">
                <input
                  type="radio"
                  name="dashboard_density"
                  value="comfortable"
                  defaultChecked={profile.dashboard_density !== "compact"}
                  className="peer sr-only"
                />
                <span className="press block cursor-pointer rounded-card px-3 py-2.5 text-center text-sm text-muted ring-1 ring-inset ring-[var(--clay-border)] peer-checked:bg-accent/10 peer-checked:text-accent-text peer-checked:ring-accent/40">
                  {dash.settings.densityComfortable}
                </span>
              </label>
              <label className="flex-1">
                <input
                  type="radio"
                  name="dashboard_density"
                  value="compact"
                  defaultChecked={profile.dashboard_density === "compact"}
                  className="peer sr-only"
                />
                <span className="press block cursor-pointer rounded-card px-3 py-2.5 text-center text-sm text-muted ring-1 ring-inset ring-[var(--clay-border)] peer-checked:bg-accent/10 peer-checked:text-accent-text peer-checked:ring-accent/40">
                  {dash.settings.densityCompact}
                </span>
              </label>
            </div>
            <p className="mt-1.5 text-xs text-muted">{dash.settings.densityHint}</p>
          </div>

          <button type="submit" className="btn-primary">
            {dash.common.save}
          </button>
        </form>
      </section>

      {/* NOTIFICATIONS ------------------------------------------------ */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.notificationsTitle}
        </h2>
        <form action={updateNotificationPrefs} className="mt-4 space-y-4">
          {profile.role !== "admin" && (
            <div>
              <input type="hidden" name="notify_email_field" value="1" />
              <label className="flex items-start gap-2.5 text-sm text-ink">
                <input
                  type="checkbox"
                  name="notify_email"
                  defaultChecked={profile.notify_email}
                  className="mt-0.5 accent-accent"
                />
                {dash.settings.notifyEmailLabel}
              </label>
              <p className="ml-6 mt-1 text-xs text-muted">
                {profile.role === "employer"
                  ? dash.settings.notifyEmailHintEmployer
                  : dash.settings.notifyEmailHintSeeker}
              </p>
            </div>
          )}

          {profile.role === "seeker" && (
            <div>
              <input type="hidden" name="notify_new_jobs_field" value="1" />
              <label className="flex items-start gap-2.5 text-sm text-ink">
                <input
                  type="checkbox"
                  name="notify_new_jobs"
                  defaultChecked={profile.notify_new_jobs}
                  className="mt-0.5 accent-accent"
                />
                {dash.settings.notifyNewJobsLabel}
              </label>
              <p className="ml-6 mt-1 text-xs text-muted">{dash.settings.notifyNewJobsHint}</p>
            </div>
          )}

          <button type="submit" className="btn-primary">
            {dash.common.save}
          </button>
        </form>
      </section>

      {/* PASSWORD ---------------------------------------------------- */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.passwordTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{dash.settings.passwordHint}</p>
        <form action={changePassword} className="mt-4 space-y-4">
          <div>
            <label htmlFor="password" className="eyebrow mb-2 block">
              {dash.settings.passwordLabel}
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="field"
            />
          </div>
          <div>
            <label htmlFor="password_confirm" className="eyebrow mb-2 block">
              {dash.settings.passwordConfirmLabel}
            </label>
            <input
              id="password_confirm"
              name="password_confirm"
              type="password"
              required
              minLength={10}
              autoComplete="new-password"
              className="field"
            />
          </div>
          <button type="submit" className="btn-primary">
            {dash.settings.passwordCta}
          </button>
        </form>
      </section>

      {/* DATA -------------------------------------------------------- */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.dataTitle}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {dash.settings.dataBody}
        </p>

        <div className="mt-5 space-y-4">
          {exportHref && (
            <div>
              <a href={exportHref} className="btn-secondary" download>
                <Download className="h-4 w-4" aria-hidden />
                {dash.settings.dataExport}
              </a>
              <p className="mt-1.5 text-xs text-muted">{dash.settings.dataExportHint}</p>
            </div>
          )}

          <div>
            {profile.role === "seeker" ? (
              <ConfirmAction
                action={deleteSeekerAccount}
                fields={{}}
                tone="danger"
                title={dash.settings.dataDeleteConfirmTitle}
                body={dash.settings.dataDeleteConfirmBody}
                confirmLabel={dash.settings.dataDeleteCta}
                triggerClassName="btn-ghost border-line"
                trigger={
                  <>
                    <Trash2 className="h-4 w-4" aria-hidden />
                    {dash.settings.dataDeleteCta}
                  </>
                }
              />
            ) : (
              <a
                href={`mailto:hello@pac.africa?subject=${encodeURIComponent(
                  "Data deletion request"
                )}&body=${encodeURIComponent(
                  `Please delete the data held for ${profile.email}.`
                )}`}
                className="btn-ghost border-line"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                {dash.settings.dataDelete}
              </a>
            )}
            <p className="mt-1.5 max-w-lg text-xs leading-relaxed text-muted">
              {dash.settings.dataDeleteHint}
            </p>
          </div>

          <p className="pt-1 text-sm">
            <Link
              href="/privacy"
              className="inline-flex items-center gap-1.5 text-accent-text transition-opacity duration-150 hover:opacity-70"
            >
              <Shield className="h-3.5 w-3.5" aria-hidden />
              {dash.settings.privacy}
            </Link>
          </p>
        </div>
      </section>

      {/* SIGN OUT ---------------------------------------------------- */}
      <section className="clay p-6">
        <h2 className="font-display text-lg font-600 text-ink">
          {dash.settings.signOutTitle}
        </h2>
        <form action="/auth/signout" method="post" className="mt-4">
          <button type="submit" className="btn-secondary">
            {dash.settings.signOut}
          </button>
        </form>
        <p className="mt-3 text-xs text-muted">
          {site.name} · {site.domain}
        </p>
      </section>
    </div>
  );
}
