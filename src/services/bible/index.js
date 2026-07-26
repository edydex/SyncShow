'use strict';

module.exports = {
  ...require('./BibleBooks'),
  ...require('./BibleReferenceParser'),
  ...require('./BibleTranslations'),
  ...require('./BibleLibrary')
};
