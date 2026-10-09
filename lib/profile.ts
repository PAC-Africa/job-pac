import type { Profile } from "@/types/database";

export type ProfileCheck = {
  label: string;
  done: boolean;
  /** Why it matters, in the applicant's terms rather than the system's. */
  why: string;
};

/**
 * What a seeker still needs to fill in.
 *
 * Deliberately only the fields that change what an employer sees or how they
 * make contact — bio and LinkedIn are genuinely optional, so including them
 * would show a permanently incomplete profile to someone who has finished.
 * A checklist you cannot finish is noise.
 */
export function profileChecklist(
  profile: Profile,
  hasCv: boolean,
  hasEducation: boolean,
  hasWorkExperience: boolean
): ProfileCheck[] {
  return [
    {
      label: "Your name",
      done: Boolean(profile.full_name?.trim()),
      why: "Employers see this instead of your email address. Required to unlock Applications.",
    },
    {
      label: "CV attached",
      done: hasCv,
      why: "Usually the first thing an employer opens. Required to unlock Applications.",
    },
    {
      label: "Phone number",
      done: Boolean(profile.phone?.trim()),
      why: "How most employers here make first contact. Required to unlock Applications.",
    },
    {
      label: "Headline",
      done: Boolean(profile.headline?.trim()),
      why: "One line on what you do, shown with your application.",
    },
    {
      label: "Skills",
      done: Boolean(profile.skills?.length),
      why: "Lets us point you at roles that match. Counts toward the 3 of 4 needed to unlock Applications.",
    },
    {
      label: "Location",
      done: Boolean(profile.address?.trim()),
      why: "Employers use it to judge the commute.",
    },
    {
      label: "Years of experience",
      done: profile.years_experience !== null,
      why: "Lets employers gauge seniority at a glance. Counts toward the 3 of 4 needed to unlock Applications.",
    },
    {
      label: "Education level",
      done: profile.education_level !== null,
      why: "Some roles filter by minimum education. Counts toward the 3 of 4 needed to unlock Applications.",
    },
    {
      label: "Industry",
      done: profile.industry_category_id !== null,
      why: "Helps us point you at roles in your field. Counts toward the 3 of 4 needed to unlock Applications.",
    },
    {
      label: "Education history",
      done: hasEducation,
      why: "At least one entry — school, field of study, and years attended. Required to unlock Applications.",
    },
    {
      label: "Work experience",
      done: hasWorkExperience,
      why: "At least one entry — employer, title, and dates. Required to unlock Applications.",
    },
  ];
}

/** Percentage of the pool (below) that must be filled, on top of every
 * hard-required field, to pass the gate. Not 100%: skills/years/education
 * level/industry each matter, but none alone is as operationally critical
 * as a name, phone, CV, or real history — so 3 of these 4 is enough. */
const GATE_POOL_THRESHOLD = 70;

export type ProfileGateStatus = {
  complete: boolean;
  /** Percentage of the 4-item pool filled in, independent of whether the
   * hard-required fields are also done — lets the UI show "3 of 4" even
   * to someone who still hasn't uploaded a CV. */
  poolPercent: number;
};

/**
 * The gate that actually locks dashboard features (Saved, Alerts,
 * Applications, and applying — see lib/auth.ts and app/jobs/actions.ts).
 * A hybrid, not a single pass/fail list and not a pure percentage either:
 *
 *  - Hard-required, every one, no exceptions: name, phone, CV, at least one
 *    education entry, at least one work-experience entry. Each is something
 *    an employer cannot act on an application without.
 *  - Pool, needs GATE_POOL_THRESHOLD%: skills, years of experience,
 *    education level, industry. Each matters, but requiring all four
 *    individually blocked seekers (e.g. a recent graduate with no industry
 *    pick yet) over fields that help rather than gate.
 *
 * bio/headline/location stay outside both lists entirely — pure nudges in
 * profileChecklist, never gating.
 */
export function profileGateStatus(
  profile: Pick<
    Profile,
    | "full_name"
    | "phone"
    | "years_experience"
    | "education_level"
    | "industry_category_id"
    | "skills"
  >,
  hasCv: boolean,
  hasEducation: boolean,
  hasWorkExperience: boolean
): ProfileGateStatus {
  const hardRequired =
    Boolean(profile.full_name?.trim()) &&
    Boolean(profile.phone?.trim()) &&
    hasCv &&
    hasEducation &&
    hasWorkExperience;

  const pool = [
    Boolean(profile.skills?.length),
    profile.years_experience !== null,
    profile.education_level !== null,
    profile.industry_category_id !== null,
  ];
  const poolPercent = Math.round((pool.filter(Boolean).length / pool.length) * 100);

  return { complete: hardRequired && poolPercent >= GATE_POOL_THRESHOLD, poolPercent };
}

export function isProfileGateComplete(
  profile: Pick<
    Profile,
    | "full_name"
    | "phone"
    | "years_experience"
    | "education_level"
    | "industry_category_id"
    | "skills"
  >,
  hasCv: boolean,
  hasEducation: boolean,
  hasWorkExperience: boolean
): boolean {
  return profileGateStatus(profile, hasCv, hasEducation, hasWorkExperience).complete;
}

export function completeness(checks: ProfileCheck[]): {
  done: number;
  total: number;
  percent: number;
} {
  const done = checks.filter((c) => c.done).length;
  return {
    done,
    total: checks.length,
    percent: Math.round((done / checks.length) * 100),
  };
}

/**
 * Accepts what people actually type for a LinkedIn profile.
 *
 * The field used `type="url"`, so the browser rejected "linkedin.com/in/jane"
 * — which is what most people paste — and silently blocked the whole form.
 * Now it takes text and gets normalised here instead.
 */
export function normaliseLinkedIn(raw: string | null): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/^@+/, "");
  if (!value) return null;

  // A bare handle, e.g. "jane-doe". Anything with whitespace or punctuation is
  // not a handle — better to store nothing than a link that 404s.
  if (!value.includes("/") && !value.includes(".")) {
    return /^[\w-]+$/.test(value)
      ? `https://www.linkedin.com/in/${value}`
      : null;
  }
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return null;
  }
}
