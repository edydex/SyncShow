'use strict';

const crypto = require('crypto');
const core = require('../../../packages/service-core/node');
const { serializeServiceProject } = core;

function heritageServiceDocumentRevision(value) {
  const source = typeof value === 'string'
    ? value
    : serializeHeritageServiceDocument(value);
  return crypto.createHash('sha256').update(source).digest('hex');
}

function createHeritageServiceDocument(project) {
  return core.createHeritageServiceDocument(project);
}

function normalizeHeritageServiceDocument(document) {
  return core.normalizeHeritageServiceDocument(document);
}

function serializeHeritageServiceDocument(document) {
  return core.serializeHeritageServiceDocument(document);
}

function parseHeritageServiceDocumentSource(source, options = {}) {
  return core.parseHeritageServiceDocumentSource(
    source,
    options
  );
}

function validateHeritageServiceDocumentSource(source, options = {}) {
  const document = parseHeritageServiceDocumentSource(source, options);
  const documentSource = serializeHeritageServiceDocument(document);
  return Object.freeze({
    document,
    project: document.project,
    documentSource,
    revision: heritageServiceDocumentRevision(documentSource)
  });
}

function replaceHeritageServiceProject(document, project) {
  return core.replaceHeritageServiceProject(
    document,
    project
  );
}

function normalizeHeritageServiceDocumentEnvelope(envelope) {
  return core.normalizeHeritageServiceDocumentEnvelope(envelope, {
    revisionForSource: heritageServiceDocumentRevision
  });
}

module.exports = {
  ...core,
  createHeritageServiceDocument,
  heritageServiceDocumentRevision,
  normalizeHeritageServiceDocument,
  normalizeHeritageServiceDocumentEnvelope,
  parseHeritageServiceDocumentSource,
  replaceHeritageServiceProject,
  serializeHeritageServiceDocument,
  serializeServiceProject,
  validateHeritageServiceDocumentSource
};
