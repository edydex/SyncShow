'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const stylesheet = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function replaceCommentsWithWhitespace(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, comment =>
    comment.replace(/[^\n]/g, ' '));
}

function declarations(body) {
  const values = new Map();
  const pattern = /(?:^|;)\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;]*?)\s*(?=;|$)/g;
  for (const match of body.matchAll(pattern)) {
    values.set(match[1], match[2].trim());
  }
  return values;
}

function references(body, bodyOffset, source) {
  const found = [];
  const pattern = /var\(\s*(--[A-Za-z0-9_-]+)(?=\s*[,)]\s*)/g;
  for (const match of body.matchAll(pattern)) {
    const offset = bodyOffset + match.index;
    found.push({
      name: match[1],
      line: source.slice(0, offset).split('\n').length
    });
  }
  return found;
}

function analyzeCustomProperties(source) {
  const clean = replaceCommentsWithWhitespace(source);
  const rules = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;

  for (const match of clean.matchAll(rulePattern)) {
    const openBrace = match[0].indexOf('{');
    const prelude = match[1].trim();
    const body = match[2];
    rules.push({
      prelude,
      declarations: declarations(body),
      references: references(body, match.index + openBrace + 1, clean)
    });
  }

  const rootDeclarations = new Map();
  for (const rule of rules) {
    if (!rule.prelude.split(',').map(selector => selector.trim()).includes(':root')) {
      continue;
    }
    for (const [name, value] of rule.declarations) {
      rootDeclarations.set(name, value);
    }
  }

  const unresolved = [];
  for (const rule of rules) {
    for (const reference of rule.references) {
      if (
        !rootDeclarations.has(reference.name)
        && !rule.declarations.has(reference.name)
      ) {
        unresolved.push({
          ...reference,
          selector: rule.prelude
        });
      }
    }
  }

  const parsedReferenceCount = rules.reduce(
    (count, rule) => count + rule.references.length,
    0
  );
  const sourceReferenceCount = [...clean.matchAll(/var\(\s*--[A-Za-z0-9_-]+/g)].length;

  return {
    parsedReferenceCount,
    rootDeclarations,
    sourceReferenceCount,
    unresolved
  };
}

test('renderer stylesheet resolves every custom property globally or in its containing rule', () => {
  const analysis = analyzeCustomProperties(stylesheet);

  assert.equal(
    analysis.parsedReferenceCount,
    analysis.sourceReferenceCount,
    'every var() reference must appear in a parsed declaration block'
  );
  assert.deepEqual(
    analysis.unresolved,
    [],
    `unresolved custom properties:\n${analysis.unresolved
      .map(reference =>
        `${reference.name} at line ${reference.line} in ${reference.selector}`)
      .join('\n')}`
  );
});

test('custom-property analysis accepts local definitions and reports genuinely missing tokens', () => {
  const fixture = [
    ':root {',
    '  --global: white;',
    '}',
    '.local {',
    '  --depth: 0;',
    '  margin-left: calc(var(--depth) * 1px);',
    '  color: var(--global);',
    '  border-color: var(--missing);',
    '}'
  ].join('\n');
  const analysis = analyzeCustomProperties(fixture);

  assert.equal(analysis.parsedReferenceCount, 3);
  assert.equal(analysis.sourceReferenceCount, 3);
  assert.deepEqual(analysis.unresolved, [{
    name: '--missing',
    line: 8,
    selector: '.local'
  }]);
});

test('renderer compatibility tokens stay pinned to the canonical dark-theme palette', () => {
  const { rootDeclarations } = analyzeCustomProperties(stylesheet);
  const expected = new Map([
    ['--accent', 'var(--primary)'],
    ['--accent-light', '#aac0ff'],
    ['--focus', '#8eabff'],
    ['--text-primary', 'var(--text)'],
    ['--radius-md', 'var(--radius)']
  ]);

  for (const [name, value] of expected) {
    assert.equal(rootDeclarations.get(name), value, `${name} must remain ${value}`);
  }
});
