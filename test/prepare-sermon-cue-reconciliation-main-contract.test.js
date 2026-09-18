'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const trustedContractSource = fs.readFileSync(
  path.join(root, 'test', 'prepare-ipc-contract.test.js'),
  'utf8'
);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve({ ok: true });
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    TextEncoder,
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle(\n  '${channel}'`;
  const compactMarker = `ipcMain.handle('${channel}'`;
  const start = Math.max(
    mainSource.indexOf(marker),
    mainSource.indexOf(compactMarker)
  );
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const nextCompact = mainSource.indexOf("\nipcMain.handle('", start + 1);
  const nextExpanded = mainSource.indexOf('\nipcMain.handle(\n  ', start + 1);
  const candidates = [nextCompact, nextExpanded].filter(index => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : mainSource.length;
  return mainSource.slice(start, end);
}

test('proposal handler binds explicit source mappings to exact immutable snapshots', () => {
  const source = handlerSource(
    'prepare:projects:proposeSermonCueReconciliation'
  );
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*64 \* 1024\)/);
  for (const key of [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'sourceMappings'
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /requireSermonCueReconciliationAnchor\(/);
  assert.match(source, /current\.project,\s*itemId,\s*sermonId,\s*sermonRevisionId/);
  assert.match(source, /failSermonCueReconciliation\(error\)/);
  assert.doesNotMatch(source, /linked\.resourceOwnerId !== itemId/);
  assert.doesNotMatch(source, /item\.groupKind !== 'sermon'/);
  assert.match(source, /localSermonLibrary\.readRevision\(/);
  assert.match(source, /exactSermonCueExtractionSnapshot\(/);
  assert.match(source, /buildSermonCueReconciliationProposal\(\{/);
  assert.match(source, /projectRevisionId:\s*current\.revisionId/);
  assert.match(source, /sourceMappings:\s*snapshots/);
  assert.match(source, /holdSermonCueReconciliationProposal\(\{\s*proposal\s*\}\)/);
  assert.doesNotMatch(source, /childIds\.length|SERMON_ANCHOR_NOT_EMPTY/);
  assert.doesNotMatch(source, /sourcePath|filePath|readFileSync|dialog\./);
});

test('apply handler revalidates held bindings and snapshots before one project CAS', () => {
  const source = handlerSource(
    'prepare:projects:applySermonCueReconciliation'
  );
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requireSermonCueReconciliationProposal\(/);
  assert.match(source, /sermonCueReconciliationApplyIntentHash\(request\)/);
  assert.match(source, /withSermonCueReconciliationApplication\(/);
  assert.match(source, /applyIntentHash,/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /readExactSnapshot\(\{/);
  assert.match(source, /snapshot\.snapshotHash !== pool\.snapshotHash/);
  assert.match(source, /applySermonCueReconciliation\(\{/);
  assert.match(source, /'placementIndex'/);
  assert.match(source, /placementIndex:\s*request\.placementIndex/);
  assert.match(source, /confirmed:\s*request\.confirmed/);
  assert.match(source, /idFactory:\s*\(\) => projectItemId\('sermon'\)/);
  assert.match(source, /reason:\s*'reconcile-sermon-cues'/);
  assert.match(source, /projectResult\(saved\)/);
  assert.match(source, /insertedItemIds:\s*applied\.insertedItemIds/);
  assert.match(source, /updatedItemIds:\s*applied\.updatedItemIds/);
  assert.match(source, /reorderedItemIds:\s*applied\.reorderedItemIds/);
  assert.doesNotMatch(source, /sourcePath|filePath|packagePath|cacheDir/);
});

test('successful apply replies remain retryable only for the exact reviewed intent', () => {
  assert.match(
    mainSource,
    /function sermonCueReconciliationApplyIntentHash\(request\)[\s\S]*?decisions: request\.decisions[\s\S]*?placementIndex: request\.placementIndex[\s\S]*?confirmed: request\.confirmed/
  );
  assert.match(
    mainSource,
    /if \(entry\.completedResult\)[\s\S]*?entry\.applyIntentHash !== applyIntentHash[\s\S]*?SERMON_CUE_RECONCILIATION_REPLAY_MISMATCH[\s\S]*?return entry\.completedResult/
  );
  assert.match(
    mainSource,
    /entry\.applyIntentHash = applyIntentHash;\s*entry\.completedResult = result;/
  );
  assert.doesNotMatch(
    mainSource,
    /if \(succeeded\) sermonCueReconciliationProposals\.delete/
  );
});

test('preload exposes only semantic reconciliation choices and trusted channels', () => {
  assert.match(
    preloadSource,
    /proposeSermonCueReconciliationForServiceItem:[\s\S]*?'prepare:projects:proposeSermonCueReconciliation'[\s\S]*?sourceMappings:\s*sermonCueSourceMappingsIntent/
  );
  assert.match(
    preloadSource,
    /applySermonCueReconciliationForServiceItem:[\s\S]*?'prepare:projects:applySermonCueReconciliation'[\s\S]*?decisions:\s*sermonCueDecisionsIntent[\s\S]*?placementIndex:\s*request\?\.placementIndex \?\? null[\s\S]*?confirmed:/
  );
  assert.match(
    preloadSource,
    /sermonCueDecisionsIntent[\s\S]*?targetItemId:\s*decision\?\.targetItemId \?\? null/
  );
  const bridgeStart = preloadSource.indexOf('// Prepare workspace');
  const bridgeEnd = preloadSource.indexOf('// App state', bridgeStart);
  const bridge = preloadSource.slice(bridgeStart, bridgeEnd);
  assert.doesNotMatch(bridge, /sourcePath|filePath|cacheDir|packagePath/);
  assert.match(
    trustedContractSource,
    /'prepare:projects:proposeSermonCueReconciliation'/
  );
  assert.match(
    trustedContractSource,
    /'prepare:projects:applySermonCueReconciliation'/
  );
});

test('preload preserves valid multi-byte cue text up to the character limit', async () => {
  const { api, calls } = loadPreloadBridge();
  const acceptedText = '漢'.repeat(20_000);
  await api.applySermonCueReconciliationForServiceItem({
    proposalToken: 'proposal-token',
    projectId: 'project-id',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-point',
    sermonId: 'sermon-id',
    sermonRevisionId: 'b'.repeat(64),
    decisions: [{
      rowId: 'row-1',
      action: 'update',
      targetItemId: 'cue-1',
      unitsByChannel: {
        primary: {
          unitId: 'unit-1',
          text: acceptedText
        }
      }
    }],
    confirmed: true
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'prepare:projects:applySermonCueReconciliation');
  assert.equal(
    calls[0].payload.decisions[0].unitsByChannel.primary.text,
    acceptedText
  );

  await api.applySermonCueReconciliationForServiceItem({
    decisions: [{
      rowId: 'row-2',
      action: 'insert',
      unitsByChannel: {
        primary: {
          unitId: 'unit-2',
          text: `${acceptedText}漢`
        }
      }
    }]
  });
  assert.equal(
    calls[1].payload.decisions[0].unitsByChannel.primary.text,
    null
  );
});
