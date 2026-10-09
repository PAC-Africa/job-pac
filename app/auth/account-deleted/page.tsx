import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

export const metadata = { title: "Account deleted" };

/**
 * Where deleteSeekerAccount() (app/dashboard/settings-actions.ts) sends you.
 * There is no session left to redirect into a dashboard with, so this is a
 * plain standalone page rather than anything behind auth — same reasoning as
 * app/auth/suspended/page.tsx.
 */
export default function AccountDeletedPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <CheckCircle2 className="mx-auto mb-5 h-8 w-8 text-accent" aria-hidden />
      <h1 className="font-display text-2xl font-700 tracking-display text-ink">
        Your account has been deleted
      </h1>
      <p className="mx-auto mt-3 text-sm leading-relaxed text-muted">
        Your profile, CV, saved roles and job alerts are gone. Applications
        you already sent stay with the employer for their own records, with
        your name, phone, cover letter and CV removed from them.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/jobs" className="btn-primary">
          Browse roles
        </Link>
        <Link href="/" className="btn-ghost">
          Back home
        </Link>
      </div>
    </div>
  );
}
