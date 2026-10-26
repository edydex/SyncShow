 'use strict';
const { createHeritageServiceDocument, serializeHeritageServiceDocument, heritageServiceDocumentRevision } = require('../community/HeritageServiceDocument');
const { translationIntent } = require('./SlideTranslationCues');
async function resolveCueBinding(presentation, binding, connection, projectStore) {
  if (projectStore && presentation?.projectId && /^[a-f0-9]{64}$/.test(presentation.projectRevisionId || '')) {
    // serviceHandoff.project is only display metadata, not a ServiceProject.
    // Read the immutable full document used to prepare these exact slides.
    const { project } = await projectStore.read(presentation.projectId, { revisionId: presentation.projectRevisionId });
    if (project.id !== presentation.projectId) throw new Error('The saved project does not match the loaded service.');
    // The operator verifies this content revision against the authenticated
    // Community plan. A local packaging revision is not a Community revision.
    return { serviceId: project.id, serviceRevision: heritageServiceDocumentRevision(serializeHeritageServiceDocument(createHeritageServiceDocument(project))) };
  }
  if (binding?.documentRevision && binding.serverId === connection?.serverId && binding.localRevisionId === presentation?.projectRevisionId)
    return { serviceId: binding.syncId, serviceRevision: binding.documentRevision };
  throw new Error('Load the saved Community service before using translation cues.');
}
function cueOutputSettings(output, command, defaults, saved) {
  const audience = output.kind !== 'singer' && output.renderer !== 'singer-current-next';
  const settings = command.settings;
  const channel = output.sourceRoleId || output.expectedRoleId || output.expectedRole;
  if (!command.manual && settings) {
    const selected = settings.captionChannel === 'both' || settings.captionChannel === channel;
    return { language: settings.targetLanguage, layout: command.phase === 'live' && audience && selected ? settings.captionStyle : 'hidden', fontScale: saved?.fontScale || 1 };
  }
  return saved || { language: defaults.sourceLanguage === 'en' ? 'ru' : 'en', layout: audience ? 'lower-third' : 'hidden', fontScale: 1 };
}
function cueScopedFrame(frame, { showActive, manual, cues = [], index } = {}) {
  // Saved layouts describe the next translation session. They must not paint
  // a band over ordinary slides, even while a feed or Stop is still pending.
  if (!showActive || manual || frame.manual || translationIntent(cues, index)?.phase === 'live') return frame;
  return { ...frame, layout: 'hidden', moving: false, phrases: [] };
}
module.exports = { resolveCueBinding, cueOutputSettings, cueScopedFrame };
