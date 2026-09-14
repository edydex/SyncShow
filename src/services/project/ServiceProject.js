'use strict';

// Keep historical imports stable while the implementation is shared with
// Heritage Community through @syncshow/service-core. The retired Community
// plan importer remains a SyncShow-only compatibility lane; the shared
// browser package deliberately excludes it.
const serviceProject = require('../../../packages/service-core/node/services/project/ServiceProject');
const {
  normalizeCommunityServicePlanBaseline
} = require('../community/CommunityServicePlanBaseline');

serviceProject.configureCommunityServicePlanBaselineNormalizer(
  normalizeCommunityServicePlanBaseline
);

module.exports = serviceProject;
