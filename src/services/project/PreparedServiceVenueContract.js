'use strict';

const crypto = require('crypto');

function preparedServiceVenueRevisionId(profile) {
  const contract = {
    profileId: profile?.id || null,
    roles: (profile?.inputRoles || [])
      .filter(role => role?.enabled === true && role.kind === 'deck')
      .map(role => ({
        id: role.id,
        label: role.label
      }))
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(contract))
    .digest('hex');
}

module.exports = {
  preparedServiceVenueRevisionId
};
