/**
 * Instagram Graph collaborator invites.
 * Optional. Max 3 usernames. Feed image, Reels, carousel parent only — not Stories, not carousel children.
 */

export const IG_COLLAB_MAX = 3;

export type CollaboratorNormalizeResult = {
  usernames: string[];
  warnings: string[];
};

const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

export function normalizeCollaborators(raw?: string[] | null): CollaboratorNormalizeResult {
  if (!raw?.length) return { usernames: [], warnings: [] };
  const warnings: string[] = [];
  const seen = new Set<string>();
  const usernames: string[] = [];

  for (const item of raw) {
    const cleaned = String(item ?? "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
    if (!cleaned) continue;
    if (!USERNAME_RE.test(cleaned)) {
      throw new Error(
        `invalid_collaborator: "${item}" is not an Instagram username. Use handles only (no URLs).`,
      );
    }
    if (seen.has(cleaned)) {
      warnings.push(`Duplicate collaborator @${cleaned} dropped.`);
      continue;
    }
    seen.add(cleaned);
    usernames.push(cleaned);
  }

  if (usernames.length > IG_COLLAB_MAX) {
    warnings.push(
      `Instagram allows at most ${IG_COLLAB_MAX} collaborators; extra usernames were dropped: ${usernames
        .slice(IG_COLLAB_MAX)
        .map((u) => `@${u}`)
        .join(", ")}.`,
    );
    usernames.length = IG_COLLAB_MAX;
  }

  return { usernames, warnings };
}

/** Set Graph `collaborators` only when the caller provided at least one username. */
export function applyCollaborators(
  body: Record<string, unknown>,
  usernames?: string[],
): Record<string, unknown> {
  if (usernames && usernames.length > 0) {
    body.collaborators = usernames;
  }
  return body;
}

export function refuseStoriesCollaborators(mediaType?: string): void {
  const t = (mediaType ?? "").toUpperCase();
  if (t === "STORIES" || t === "STORY") {
    throw new Error(
      "collaborators_not_supported: Instagram Stories cannot receive collaborator invites via Graph. Use feed image, Reels, or carousel. Business Suite is the fallback if an invite fails.",
    );
  }
}

export function collaboratorsForIgOnly(
  platforms: string[] | undefined,
  usernames: string[],
): { ig: string[]; ignoredWarning?: string } {
  if (!usernames.length) return { ig: [] };
  const igOnly = !platforms?.length || platforms.includes("meta_ig") || platforms.includes("ig");
  if (!igOnly && platforms && !platforms.includes("meta_ig")) {
    return {
      ig: [],
      ignoredWarning:
        "collaborators are Instagram Graph only and were ignored because platforms[] does not include meta_ig.",
    };
  }
  return { ig: usernames };
}
