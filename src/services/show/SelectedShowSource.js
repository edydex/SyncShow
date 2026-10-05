'use strict';

// A failed native load must never silently launch a previously loaded deck.
// The verified package identity is checked again in main before outputs open.
function assertSelectedShowSource(request, preparedService, launchPlan) {
  if (request.sourceMode === undefined) return;
  const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (!['syncshow', 'pptx'].includes(request.sourceMode)) {
    fail('INVALID_SHOW_SOURCE', 'Choose a SyncShow service or Legacy PPTX files before starting.');
  }
  if (request.sourceMode === 'syncshow') {
    const binding = preparedService?.binding;
    if (!binding || !request.expectedProjectId || !request.expectedRevisionId
      || binding.projectId !== request.expectedProjectId
      || binding.projectRevisionId !== request.expectedRevisionId) {
      fail('SELECTED_SERVICE_NOT_LOADED', 'The selected SyncShow service has not been loaded successfully. Load it again before starting.');
    }
    if (launchPlan.outputs.some(output => output.renderer !== 'native-cue')) {
      fail('SELECTED_SERVICE_NOT_LOADED', 'The selected SyncShow service is not available for every chosen output. Load it again before starting.');
    }
  } else if (launchPlan.outputs.some(output => output.renderer === 'native-cue')) {
    fail('SELECTED_POWERPOINT_NOT_LOADED', 'Choose PowerPoint files in Legacy PPTX files before starting.');
  }
}

module.exports = { assertSelectedShowSource };
