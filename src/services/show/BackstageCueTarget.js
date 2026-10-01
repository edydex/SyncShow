'use strict';

// A click names the cue the operator saw, never an ordinal in a changed deck.
// Advance uses the current cue's identity and then the latest draft ordering.
function resolveBackstageCueTarget({ previousCueIds, nextCueIds, currentIndex, targetIndex, cueId, advance = 0 }) {
  if (!Array.isArray(previousCueIds) || !Array.isArray(nextCueIds)
    || nextCueIds.some(id => typeof id !== 'string' || !id)
    || new Set(nextCueIds).size !== nextCueIds.length) {
    return { accepted: false, code: 'DRAFT_CUE_IDENTITIES_INVALID', message: 'The saved draft has ambiguous slide identities. Return to Load before showing it.' };
  }
  const wantedId = cueId || previousCueIds[advance ? currentIndex : targetIndex];
  const matchedIndex = typeof wantedId === 'string' ? nextCueIds.indexOf(wantedId) : -1;
  if (matchedIndex < 0) {
    return { accepted: false, code: 'DRAFT_CUE_REMOVED', message: advance
      ? 'The live slide was removed from the draft. Choose another slide, or return to Load. The current screen is unchanged.'
      : 'That slide was removed from the draft. Choose another slide, or return to Load. The current screen is unchanged.' };
  }
  const index = matchedIndex + advance;
  if (index < 0 || index >= nextCueIds.length) {
    return { accepted: false, code: advance < 0 ? 'AT_FIRST_CUE' : 'AT_LAST_CUE', message: advance < 0
      ? 'The saved draft is already at its first slide.' : 'The saved draft is already at its last slide.' };
  }
  const oldCurrentId = previousCueIds[currentIndex];
  const currentMatch = nextCueIds.indexOf(oldCurrentId);
  return { accepted: true, targetIndex: index, currentIndex: currentMatch < 0 ? index : currentMatch, cueId: nextCueIds[index] };
}

module.exports = { resolveBackstageCueTarget };
