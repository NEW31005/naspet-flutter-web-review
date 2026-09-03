export function isCompletedVoteMismatch(
  masterChoiceId: string | null,
  buddyVoteId: string | null | undefined,
): boolean {
  return buddyVoteId != null && masterChoiceId !== buddyVoteId;
}
