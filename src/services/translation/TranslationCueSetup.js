 'use strict';
const { createHeritageServiceDocument, serializeHeritageServiceDocument, heritageServiceDocumentRevision } = require('../community/HeritageServiceDocument');
function resolveCueBinding(presentation, binding, connection) {
  const project = presentation?.serviceHandoff?.project;
  if (project?.id === presentation.projectId) {
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
module.exports = { resolveCueBinding, cueOutputSettings };
