/**
 * Skill-overlap match percentage between a job and a seeker.
 *
 * `null` means "don't show a badge" — a job with no required_skills set has
 * nothing to grade against, and a viewer with no skills on file (including
 * every signed-out visitor, whose skills are always null) has nothing to
 * grade either. Showing 0% for either case would be a meaningless number
 * dressed up as a real one — and for a signed-out visitor specifically, a
 * badge that always reads 0% is effectively just advertising the gate to
 * people who can't act on it yet. Mirrors how the profile checklist
 * (lib/profile.ts) never shows a permanently-broken state for something
 * that was never asked for.
 */
export function matchPercent(
  requiredSkills: string[] | null | undefined,
  seekerSkills: string[] | null | undefined
): number | null {
  if (!requiredSkills || requiredSkills.length === 0) return null;
  if (!seekerSkills || seekerSkills.length === 0) return null;

  const required = new Set(requiredSkills.map((s) => s.toLowerCase().trim()));
  const seeker = new Set(seekerSkills.map((s) => s.toLowerCase().trim()));

  let matched = 0;
  for (const skill of required) if (seeker.has(skill)) matched++;

  return Math.round((matched / required.size) * 100);
}
