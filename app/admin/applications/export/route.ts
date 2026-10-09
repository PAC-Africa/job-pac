import { NextRequest, NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth";
import { buildApplicationsQuery, type ApplicationFilterParams } from "@/lib/admin-applications-query";
import { cvStatus } from "@/lib/cv";
import type { ApplicationStatus } from "@/types/database";

// Safety net, not an expected ceiling — 4,356 applications exist today.
// Exists so a future traffic spike produces a slow response, not an
// unbounded one.
const MAX_ROWS = 10_000;

type Row = {
  applicant_name: string | null;
  applicant_email: string;
  wp_job_title: string | null;
  job: { title: string } | { title: string }[] | null;
  status: ApplicationStatus;
  applied_at: string;
  meets_requirements: boolean | null;
  cv_url: string | null;
};

/** Quotes a field only if it needs it — comma, quote, or newline inside. */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * CSV export of the admin applications view — same filters as the page
 * itself (see lib/admin-applications-query.ts), so this exports exactly
 * what's currently on screen, not a separate "everything" dump.
 */
export async function GET(request: NextRequest) {
  const { supabase } = await requireProfile("admin");

  const params: ApplicationFilterParams = Object.fromEntries(
    request.nextUrl.searchParams.entries()
  );

  const { query } = await buildApplicationsQuery(supabase, params);
  const { data, error } = await query.range(0, MAX_ROWS - 1);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];

  const header = [
    "Name",
    "Email",
    "Job title",
    "Status",
    "Applied at",
    "Meets requirements",
    "CV",
  ];
  const lines = [header.join(",")];

  for (const row of rows) {
    const jobTitle = (Array.isArray(row.job) ? row.job[0]?.title : row.job?.title) ?? row.wp_job_title ?? "";
    lines.push(
      [
        csvField(row.applicant_name ?? ""),
        csvField(row.applicant_email),
        csvField(jobTitle),
        csvField(row.status),
        csvField(row.applied_at),
        csvField(row.meets_requirements === null ? "" : row.meets_requirements ? "yes" : "no"),
        csvField(cvStatus(row.cv_url)),
      ].join(",")
    );
  }

  return new NextResponse(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="applications-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store, max-age=0",
    },
  });
}
