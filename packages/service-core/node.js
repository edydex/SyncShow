'use strict';

// Node entry point: the exact native project schema, mutations, compiler, and
// readiness logic used by SyncShow plus the browser-safe service envelope.
const envelope = require('./index');
const project = require('./node/services/project/ServiceProject');

function projectOptions(options = {}) {
  return {
    ...options,
    normalizeProject: value => project.normalizeServiceProject(value, {
      now: new Date(0)
    })
  };
}

function createHeritageServiceDocument(value) {
  return envelope.createHeritageServiceDocument(value, projectOptions());
}

function normalizeHeritageServiceDocument(value) {
  return envelope.normalizeHeritageServiceDocument(value, projectOptions());
}

function parseHeritageServiceDocumentSource(source, options = {}) {
  return envelope.parseHeritageServiceDocumentSource(
    source,
    projectOptions(options)
  );
}

function replaceHeritageServiceProject(document, value) {
  return envelope.replaceHeritageServiceProject(
    document,
    value,
    projectOptions()
  );
}

function serializeHeritageServiceDocument(value) {
  return envelope.serializeHeritageServiceDocument(value, projectOptions());
}

function normalizeHeritageServiceDocumentEnvelope(value, options = {}) {
  return envelope.normalizeHeritageServiceDocumentEnvelope(
    value,
    projectOptions(options)
  );
}

module.exports = {
  ...envelope,
  ...project,
  createHeritageServiceDocument,
  normalizeHeritageServiceDocument,
  normalizeHeritageServiceDocumentEnvelope,
  parseHeritageServiceDocumentSource,
  replaceHeritageServiceProject,
  serializeHeritageServiceDocument
};
