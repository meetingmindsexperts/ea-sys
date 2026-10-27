/**
 * A speaker row carries the speaker's abstracts and session proposals, which
 * have their own read keys. `speakers.read` alone is not enough to see them
 * (owner, Oct 27, 2026: "permission need to be given"): a custom role such as
 * Sales or Onsite that lists speakers without `abstracts.read` gets the row
 * without its abstracts (or their count), and without `proposals.read`
 * without its proposals. Pure, so the list and the detail route share it.
 */
export interface SubmissionVisibility {
  abstracts: boolean;
  proposals: boolean;
}

type WithSubmissions = {
  abstracts?: unknown;
  sessionProposals?: unknown;
  _count?: Record<string, number>;
};

export function withVisibleSubmissions<T extends WithSubmissions>(speaker: T, visible: SubmissionVisibility): T {
  if (visible.abstracts && visible.proposals) return speaker;
  const out: WithSubmissions = { ...speaker };
  if (!visible.abstracts) {
    delete out.abstracts;
    if (out._count) {
      const { abstracts: _hidden, ...count } = out._count;
      void _hidden;
      out._count = count;
    }
  }
  if (!visible.proposals) delete out.sessionProposals;
  return out as T;
}
