'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);
const {
  resolveWeeklyReadinessActions
} = require('../src/renderer/weekly-readiness-actions');

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('weekly service dates advance from the exact template without drifting in local time', () => {
  const { nextWeeklyServiceDate } = rendererExports();
  assert.equal(
    nextWeeklyServiceDate('2026-07-26', '2026-07-28'),
    '2026-08-02'
  );
  assert.equal(
    nextWeeklyServiceDate('2026-07-26', '2026-08-10'),
    '2026-08-16'
  );
  assert.equal(
    nextWeeklyServiceDate('not-a-date', '2026-08-10'),
    '2026-08-10'
  );
});

test('service summaries group deterministically while preserving order inside each group', () => {
  const { groupServiceProjectSummaries } = rendererExports();
  const summaries = [
    {
      id: 'follow-up-first',
      serviceDate: '2026-07-26',
      planning: { status: 'needs-follow-up', startTime: '10:30' }
    },
    {
      id: 'future-first',
      serviceDate: '2026-08-09',
      planning: { status: 'ready', startTime: '10:30' }
    },
    {
      id: 'completed-future',
      serviceDate: '2026-08-16',
      planning: { status: 'completed', startTime: '10:30' }
    },
    {
      id: 'today-unplanned',
      serviceDate: '2026-08-02'
    },
    {
      id: 'follow-up-second',
      serviceDate: '2026-08-01',
      planning: { status: 'needs-follow-up', startTime: '18:00' }
    },
    {
      id: 'past-unplanned',
      serviceDate: '2026-07-19'
    }
  ];
  const before = JSON.stringify(summaries);
  const groups = plain(groupServiceProjectSummaries(summaries, '2026-08-02'));

  assert.equal(JSON.stringify(summaries), before);
  assert.deepEqual(
    groups.map(group => ({
      id: group.id,
      items: group.items.map(item => item.id)
    })),
    [
      {
        id: 'upcoming',
        items: ['future-first', 'today-unplanned']
      },
      {
        id: 'needs-follow-up',
        items: ['follow-up-first', 'follow-up-second']
      },
      {
        id: 'past',
        items: ['completed-future', 'past-unplanned']
      }
    ]
  );
});

test('Prepare exposes an explicit plan-and-review workflow without changing Load or Show copy', () => {
  for (const id of [
    'newServiceProjectStartTime',
    'newServiceProjectTeamNotes',
    'btnPlanNextService',
    'planNextServiceDialog',
    'planNextServiceStartTime',
    'planNextServiceTeamNotes',
    'preparePlanningStatusActions',
    'prepareServiceReadiness',
    'prepareWeeklySetupNext',
    'btnContinueWeeklySetup',
    'prepareWeeklySetupHelp',
    'prepareWeeklySetupStatus',
    'btnReviewServiceReadiness',
    'btnAddServiceSermon',
    'weeklySermonAnchorDialog',
    'weeklySermonAnchorChoices',
    'serviceReadinessDialog',
    'serviceReadinessReviewChecks',
    'serviceReadinessConfirmed',
    'btnSaveServiceReadiness',
    'btnMarkServiceReady'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /The new service opens in Planning so its order and weekly checks can be reviewed before Ready\./
  );
  assert.match(
    htmlSource,
    /id="newServiceProjectStartTime"[^>]*type="time"[^>]*required/
  );
  assert.match(
    htmlSource,
    /Last week’s sermon slides, sermon reading, private sermon packet, links, and unused files are cleared\./
  );
  assert.match(
    htmlSource,
    /Ready means the exact order, content, and any stated exceptions have been reviewed\. Save &amp; go to Load remains a separate step\./
  );
  assert.match(
    htmlSource,
    /An exception needs a specific human reason and applies only until projected content changes\./
  );
  assert.match(
    htmlSource,
    /id="btnReviewServiceReadiness"[^>]*aria-haspopup="dialog"[^>]*aria-controls="serviceReadinessDialog"/
  );
  assert.match(
    htmlSource,
    /data-service-planning-status="ready"[^>]*aria-haspopup="dialog"[^>]*aria-controls="serviceReadinessDialog"/
  );
  assert.match(htmlSource, /id="serviceReadinessTitle" tabindex="-1"/);
  assert.match(controllerSource, /'planNextServiceProject'/);
  assert.match(controllerSource, /'setServicePlanningStatus'/);
  assert.match(controllerSource, /'updateServicePlanning'/);
  assert.match(
    controllerSource,
    /state\.currentProject\.planning\.status === 'ready'[\s\S]*state\.readiness\?\.ready === true/
  );
  assert.match(
    controllerSource,
    /if \(status === 'ready'\) \{[\s\S]*openServiceReadinessReview/
  );
  assert.match(controllerSource, /dataset\.readinessWaiverReason = 'true'/);
  assert.match(controllerSource, /sourceRevisionId: state\.revisionId|const sourceRevisionId = state\.revisionId/);
  assert.match(htmlSource, /id="btnStartPresentation"[^>]*>[\s\S]*?Start Show/);
});

test('the center pane is the one user-scrollable owner for Planning and the rundown', () => {
  const paneRule = stylesSource.match(/\.prepare-rundown-pane\s*\{([^}]*)\}/u)?.[1];
  const rundownRule = stylesSource.match(/\.prepare-rundown-list\s*\{([^}]*)\}/u)?.[1];
  assert.ok(paneRule, 'the center pane needs its own CSS rule');
  assert.ok(rundownRule, 'the rundown needs its own CSS rule');
  assert.match(paneRule, /overflow-y:\s*auto/u);
  assert.match(rundownRule, /flex:\s*0\s+0\s+auto/u);
  assert.match(rundownRule, /overflow:\s*visible/u);
  assert.doesNotMatch(rundownRule, /overflow-y:\s*(?:auto|scroll)/u);

  const paneStart = htmlSource.indexOf(
    '<section class="prepare-column prepare-rundown-pane"'
  );
  const paneEnd = htmlSource.indexOf('</section>', htmlSource.indexOf(
    '<ol id="prepareRundownList"',
    paneStart
  ));
  const planningPanel = htmlSource.indexOf(
    '<section id="preparePlanningPanel"',
    paneStart
  );
  const rundown = htmlSource.indexOf(
    '<ol id="prepareRundownList"',
    paneStart
  );
  assert.ok(
    paneStart >= 0
      && planningPanel > paneStart
      && rundown > planningPanel
      && paneEnd > rundown,
    'Planning and the rundown must remain inside the same center scroll owner'
  );
});

test('actionable weekly checks load before Prepare and expose one primary plus revision-bound blocker actions', () => {
  const contractScript = htmlSource.indexOf(
    '<script src="weekly-readiness-actions.js"></script>'
  );
  const continuationScript = htmlSource.indexOf(
    '<script src="native-workflow-continuation.js"></script>'
  );
  const controllerScript = htmlSource.indexOf(
    '<script src="prepare-controller.js"></script>'
  );
  assert.ok(
    contractScript >= 0
    && continuationScript > contractScript
    && controllerScript > continuationScript
  );
  assert.match(
    htmlSource,
    /id="btnContinueWeeklySetup"[^>]*aria-describedby="prepareWeeklySetupHelp prepareWeeklySetupStatus"[^>]*disabled/
  );

  const resolveStart = controllerSource.indexOf(
    'function resolveCurrentWeeklyReadinessActions()'
  );
  const resolveEnd = controllerSource.indexOf(
    '\n    function weeklyReadinessActionMatches',
    resolveStart
  );
  assert.ok(resolveStart >= 0 && resolveEnd > resolveStart);
  const resolveSource = controllerSource.slice(resolveStart, resolveEnd);
  assert.match(resolveSource, /state\.readiness/);
  assert.match(resolveSource, /projectId: state\.currentProject\.id/);
  assert.match(resolveSource, /projectRevision: state\.currentProject\.revision/);
  assert.match(resolveSource, /revisionId: state\.revisionId/);

  const renderStart = controllerSource.indexOf(
    'function renderServiceReadiness()'
  );
  const renderEnd = controllerSource.indexOf(
    '\n    function renderPlanningOperationalSummary',
    renderStart
  );
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const renderSource = controllerSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /resolveCurrentWeeklyReadinessActions\(\)/);
  assert.match(
    renderSource,
    /actionResolution\.actions\.find\(candidate =>[\s\S]*candidate\.checkId === check\.id/
  );
  assert.match(
    renderSource,
    /item\.appendChild\(createWeeklyReadinessActionButton\(action, true\)\)/
  );
  assert.match(
    renderSource,
    /const workflowContinuation = resolveCurrentNativeWorkflowContinuation\([\s\S]*actionResolution/
  );
  assert.match(
    renderSource,
    /elements\.btnContinueWeeklySetup\.dataset\.weeklyReadinessAction =/
  );
  assert.match(
    renderSource,
    /elements\.btnContinueWeeklySetup\.textContent = workflowContinuation[\s\S]*workflowContinuation\.label/
  );
  assert.match(renderSource, /dataset\.workflowContinuation =/);
  assert.match(renderSource, /workflowContinuation\.help/);

  const buttonStart = controllerSource.indexOf(
    'function createWeeklyReadinessActionButton('
  );
  const buttonEnd = controllerSource.indexOf(
    '\n    function renderServiceReadiness',
    buttonStart
  );
  assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
  const buttonSource = controllerSource.slice(buttonStart, buttonEnd);
  assert.match(buttonSource, /button\.type = 'button'/);
  assert.match(buttonSource, /button\.dataset\.weeklyReadinessAction = action\.checkId/);
  assert.match(buttonSource, /runWeeklyReadinessAction\(action\)/);
});

test('weekly action clicks re-resolve exact currentness and never invoke the zero-sermon mutator', () => {
  const matchStart = controllerSource.indexOf(
    'function weeklyReadinessActionMatches('
  );
  const matchEnd = controllerSource.indexOf(
    '\n    function setWeeklySetupStatus',
    matchStart
  );
  assert.ok(matchStart >= 0 && matchEnd > matchStart);
  const matchSource = controllerSource.slice(matchStart, matchEnd);
  for (const field of [
    'checkId',
    'targetKind',
    'projectId',
    'projectRevision',
    'revisionId'
  ]) {
    assert.match(matchSource, new RegExp(`left\\.${field} === right\\.${field}`));
  }
  assert.match(
    matchSource,
    /resolveCurrentWeeklyReadinessActions\(\)[\s\S]*resolution\.actions\.find/
  );

  const navigateStart = controllerSource.indexOf(
    'function navigateWeeklySermonReadiness('
  );
  const navigateEnd = controllerSource.indexOf(
    '\n    function selectRundownItemForWeeklyAction',
    navigateStart
  );
  assert.ok(navigateStart >= 0 && navigateEnd > navigateStart);
  const navigateSource = controllerSource.slice(navigateStart, navigateEnd);
  assert.match(navigateSource, /resolution\.action === 'create'/);
  assert.match(navigateSource, /focusWeeklySetupControl\([\s\S]*elements\.btnAddSermon/);
  assert.match(navigateSource, /did not change the service automatically/);
  assert.doesNotMatch(
    navigateSource,
    /startWeeklySermonSetup|mutateProject|createServiceGroup|\bapi\./
  );

  const runStart = controllerSource.indexOf(
    'function runWeeklyReadinessAction('
  );
  const runEnd = controllerSource.indexOf(
    '\n    function closeWeeklySermonAnchorChooser',
    runStart
  );
  assert.ok(runStart >= 0 && runEnd > runStart);
  const runSource = controllerSource.slice(runStart, runEnd);
  assert.match(runSource, /const action = currentWeeklyReadinessAction\(descriptor\)/);
  assert.match(runSource, /belongs to an older service revision/);
  for (const targetKind of [
    'add-content',
    'song-library',
    'weekly-sermon',
    'sermon-material',
    'sermon-reading',
    'output-treatments'
  ]) {
    assert.match(runSource, new RegExp(`'${targetKind}'`));
  }
  assert.doesNotMatch(
    runSource,
    /startWeeklySermonSetup|mutateProject|createServiceGroup|\bapi\.|PowerPoint|publishCommunity|pushCommunity/
  );

  const primaryListenerStart = controllerSource.indexOf(
    "elements.btnContinueWeeklySetup.addEventListener('click'"
  );
  assert.ok(primaryListenerStart >= 0);
  const primaryListenerSource = controllerSource.slice(
    primaryListenerStart,
    primaryListenerStart + 360
  );
  assert.match(primaryListenerSource, /state\.workflowContinuation/);
  assert.match(
    primaryListenerSource,
    /runNativeWorkflowContinuation\(state\.workflowContinuation\)/
  );

  const continuationStart = controllerSource.indexOf(
    'function runNativeWorkflowContinuation('
  );
  const continuationEnd = controllerSource.indexOf(
    '\n    function closeWeeklySermonAnchorChooser',
    continuationStart
  );
  assert.ok(continuationStart >= 0 && continuationEnd > continuationStart);
  const continuationSource = controllerSource.slice(
    continuationStart,
    continuationEnd
  );
  assert.match(
    continuationSource,
    /const continuation = currentNativeWorkflowContinuation\(descriptor\)/
  );
  assert.match(continuationSource, /continuation\.kind === 'readiness-blocker'/);
  assert.match(continuationSource, /runWeeklyReadinessAction\(continuation\.readinessAction\)/);
  assert.match(continuationSource, /continuation\.kind === 'review-ready'/);
  assert.match(continuationSource, /openServiceReadinessReview\(\{ focusConfirmation: true \}\)/);
  assert.match(continuationSource, /continuation\.kind === 'publish-load'/);
  assert.match(continuationSource, /publishProject\(\)/);
  assert.doesNotMatch(
    continuationSource,
    /\bapi\.|mutateProject|setServicePlanningStatus|publishServiceProject|Community/
  );
});

test('the sermon chooser preserves button semantics inside list items and returns through revision-bound continuation', () => {
  const start = controllerSource.indexOf(
    'function openWeeklySermonAnchorChooser('
  );
  const end = controllerSource.indexOf(
    '\n    async function startWeeklySermonSetup',
    start
  );
  assert.ok(start >= 0 && end > start);
  const source = controllerSource.slice(start, end);

  assert.match(source, /const listItem = createElement\('div', 'prepare-weekly-sermon-choice-item'\)/);
  assert.match(source, /listItem\.setAttribute\('role', 'listitem'\)/);
  assert.match(source, /const button = createElement\('button', 'prepare-weekly-sermon-choice'\)/);
  assert.match(source, /button\.type = 'button'/);
  assert.match(source, /listItem\.appendChild\(button\)/);
  assert.doesNotMatch(source, /button\.setAttribute\('role', 'listitem'\)/);
  assert.match(source, /Boolean\(currentWeeklyReadinessAction\(context\.readinessAction\)\)/);
  assert.match(source, /readinessAction: readinessContinuation/);
  assert.match(source, /querySelector\('button'\)\?\.focus\(\)/);
  assert.match(
    htmlSource,
    /id="weeklySermonAnchorDialog"[^>]*aria-labelledby="weeklySermonAnchorTitle"[^>]*aria-describedby="weeklySermonAnchorDescription"/
  );
});

test('New service creates a native Planning project with the requested local schedule', () => {
  const start = controllerSource.indexOf('async function createProject(event)');
  const end = controllerSource.indexOf(
    '\n    function openPlanNextServiceDialog',
    start
  );
  assert.ok(start >= 0 && end > start);
  const source = controllerSource.slice(start, end);

  assert.match(source, /const startTime = elements\.newProjectStartTime\.value/);
  assert.match(source, /const teamNotes = elements\.newProjectTeamNotes\.value/);
  assert.match(
    source,
    /valid local start time/
  );
  assert.match(
    source,
    /api\.createServiceProject\(\{[\s\S]*title,[\s\S]*serviceDate,[\s\S]*startTime,[\s\S]*teamNotes/
  );
  assert.match(source, /applyProjectResultAfterValidation\(/);
  assert.match(
    source,
    /result\?\.project\?\.planning\?\.status !== 'planning'/
  );
  assert.match(
    source,
    /result\.project\.planning\.startTime !== startTime/
  );
  assert.match(
    source,
    /is open in Planning\. Add the first service item, then review the weekly checks before Ready\./
  );
  assert.doesNotMatch(
    source,
    /PowerPoint|planNextServiceProject|publishCommunity/
  );
});

test('native weekly sermon entry resolves zero, one, and many anchors without guessing', () => {
  const { weeklySermonAnchorResolution } = rendererExports();
  assert.deepEqual(
    plain(weeklySermonAnchorResolution({
      rootItemIds: [],
      items: {},
      resources: {}
    })),
    {
      action: 'create',
      candidates: []
    }
  );

  const one = weeklySermonAnchorResolution({
    rootItemIds: ['service'],
    items: {
      service: {
        id: 'service',
        kind: 'group',
        groupKind: 'section',
        title: 'Sunday Service',
        childIds: ['sermon-a']
      },
      'sermon-a': {
        id: 'sermon-a',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Morning sermon',
        childIds: [],
        sermonResourceId: 'packet-a'
      }
    },
    resources: {
      'packet-a': {
        id: 'packet-a',
        kind: 'sermon'
      }
    }
  });
  assert.deepEqual(plain(one), {
    action: 'select',
    candidates: [{
      itemId: 'sermon-a',
      title: 'Morning sermon',
      parentPath: 'Sunday Service',
      linked: true
    }]
  });

  const many = weeklySermonAnchorResolution({
    rootItemIds: ['service', 'sermon-b'],
    items: {
      service: {
        id: 'service',
        kind: 'group',
        groupKind: 'section',
        title: 'Sunday Service',
        childIds: ['sermon-a']
      },
      'sermon-a': {
        id: 'sermon-a',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Morning sermon',
        childIds: []
      },
      'sermon-b': {
        id: 'sermon-b',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Evening sermon',
        childIds: []
      }
    },
    resources: {}
  });
  assert.equal(many.action, 'choose');
  assert.deepEqual(
    plain(many.candidates.map(candidate => candidate.itemId)),
    ['sermon-a', 'sermon-b']
  );
  assert.ok(Object.isFrozen(many));
  assert.ok(Object.isFrozen(many.candidates));
});

test('native weekly sermon entry uses exact-CAS group mutation and existing packet workflow only', () => {
  const start = controllerSource.indexOf(
    'async function startWeeklySermonSetup()'
  );
  const end = controllerSource.indexOf(
    '\n    async function createNextServicePlan',
    start
  );
  assert.ok(start >= 0 && end > start);
  const source = controllerSource.slice(start, end);

  assert.match(source, /resolution\.action === 'select'/);
  assert.match(source, /resolution\.action === 'choose'/);
  assert.match(source, /mutateProject\(/);
  assert.match(source, /api\.createServiceGroup\(\{/);
  assert.match(source, /expectedRevisionId: state\.revisionId/);
  assert.match(source, /groupKind: 'sermon'/);
  assert.match(source, /added\.length === 1/);
  assert.match(source, /Nothing was selected or guessed/);
  assert.doesNotMatch(source, /trackHistory:\s*false/);
  assert.doesNotMatch(
    source,
    /api\.[A-Za-z0-9_]*PowerPoint|createSermonPacketForServiceItem|sourceSermonForServiceItem|pushCommunity|publishCommunity/
  );

  const selectStart = controllerSource.indexOf(
    'function selectWeeklySermonAnchor('
  );
  const selectEnd = controllerSource.indexOf(
    '\n    function openWeeklySermonAnchorChooser',
    selectStart
  );
  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  const selectSource = controllerSource.slice(selectStart, selectEnd);
  assert.match(selectSource, /state\.selectedItemId = candidate\.itemId/);
  assert.match(selectSource, /Choose a saved sermon packet and Link exact revision, or Create packet/);
  assert.match(selectSource, /rowButton\?\.focus\(\)/);

  assert.match(
    controllerSource,
    /const weeklySermon = weeklySermonAnchorResolution\(planned\.project\);[\s\S]*weeklySermon\.action === 'select'[\s\S]*weeklySermon\.candidates\[0\]\.itemId/
  );
});

test('removing a saved exception is a candidate blocker until it is reviewed again', () => {
  const { serviceReadinessCandidateHasBlocker } = rendererExports();
  const waivedReport = {
    checks: [{
      id: 'song-present',
      waivable: true,
      status: 'waived'
    }]
  };
  assert.equal(
    serviceReadinessCandidateHasBlocker(waivedReport, {
      'song-present': 'This service intentionally has no songs.'
    }),
    false
  );
  assert.equal(serviceReadinessCandidateHasBlocker(waivedReport, {}), true);
  assert.equal(
    serviceReadinessCandidateHasBlocker({
      checks: [{
        id: 'compilable-nonempty',
        waivable: false,
        status: 'blocker'
      }]
    }),
    true
  );
});

test('readiness copy is explicit and never repeats blocker instructions as a passing state', () => {
  const { serviceReadinessCheckCopy } = rendererExports();
  assert.deepEqual(
    plain(serviceReadinessCheckCopy({
      label: 'Communal singing',
      status: 'pass',
      message: 'Add at least one song to the service order.'
    })),
    {
      summary: 'Communal singing: Pass',
      detail: 'Requirement satisfied for this exact service revision.'
    }
  );
  assert.deepEqual(
    plain(serviceReadinessCheckCopy({
      label: 'Communal singing',
      status: 'blocker',
      message: 'Add at least one song to the service order.'
    })),
    {
      summary: 'Communal singing: Needs review',
      detail: 'Add at least one song to the service order.'
    }
  );
  assert.deepEqual(
    plain(serviceReadinessCheckCopy({
      label: 'Communal singing',
      status: 'waived',
      waiverReason: 'Special spoken-word service.'
    })),
    {
      summary: 'Communal singing: Reviewed exception',
      detail: 'Exception: Special spoken-word service.'
    }
  );
});

test('readiness reports fail closed unless all six ordered checks match the exact project', () => {
  const { normalizeServiceReadinessReport } = rendererExports();
  const project = {
    id: 'service-2026-08-02',
    revision: 7,
    channelIds: ['front-projector'],
    planning: { status: 'planning' }
  };
  const definitions = [
    ['compilable-nonempty', false],
    ['song-present', true],
    ['exact-sermon-link', true],
    ['linked-sermon-material', true],
    ['sermon-reading-before-material', true],
    ['channel-visible-content', true]
  ];
  const report = {
    schemaVersion: 1,
    kind: 'syncshow-service-readiness-report',
    projectId: project.id,
    projectRevision: 7,
    projectContentHash: 'a'.repeat(64),
    cueCount: 18,
    ready: false,
    planning: { present: true, status: 'planning' },
    checks: definitions.map(([id, waivable], index) => ({
      id,
      waivable,
      status: index === 1 ? 'blocker' : 'pass',
      message: `Check ${index + 1}`,
      evidence: [
        { cueCount: 18, compilationCode: null },
        { count: 0, itemIds: [] },
        {
          count: 1,
          sermonRevisionIds: ['b'.repeat(64)],
          ambiguousOwnerSets: []
        },
        { count: 1, itemIds: ['sermon-material'] },
        {
          count: 1,
          itemIds: ['sermon-reading'],
          requiredSermonResourceIds: [`sha256:${'b'.repeat(64)}`],
          missingSermonResourceIds: []
        },
        {
          coveredChannelIds: ['front-projector'],
          missingChannelIds: []
        }
      ][index]
    }))
  };

  assert.deepEqual(
    plain(normalizeServiceReadinessReport(report, project)),
    {
      projectId: project.id,
      projectRevision: 7,
      projectContentHash: 'a'.repeat(64),
      ready: false,
      cueCount: 18,
      checks: [
        {
          id: 'compilable-nonempty',
          label: 'Compilable service',
          waivable: false,
          status: 'pass',
          message: 'Check 1',
          evidence: {
            cueCount: 18,
            compilationCode: null
          }
        },
        {
          id: 'song-present',
          label: 'Communal singing',
          waivable: true,
          status: 'blocker',
          message: 'Check 2',
          evidence: {
            count: 0,
            itemIds: []
          }
        },
        {
          id: 'exact-sermon-link',
          label: 'Exact sermon packet',
          waivable: true,
          status: 'pass',
          message: 'Check 3',
          evidence: {
            count: 1,
            sermonRevisionIds: ['b'.repeat(64)],
            ambiguousOwnerSets: []
          }
        },
        {
          id: 'linked-sermon-material',
          label: 'Projected sermon material',
          waivable: true,
          status: 'pass',
          message: 'Check 4',
          evidence: {
            count: 1,
            itemIds: ['sermon-material']
          }
        },
        {
          id: 'sermon-reading-before-material',
          label: 'Reading before the sermon',
          waivable: true,
          status: 'pass',
          message: 'Check 5',
          evidence: {
            count: 1,
            itemIds: ['sermon-reading'],
            requiredSermonResourceIds: [`sha256:${'b'.repeat(64)}`],
            missingSermonResourceIds: []
          }
        },
        {
          id: 'channel-visible-content',
          label: 'Every output has content',
          waivable: true,
          status: 'pass',
          message: 'Check 6',
          evidence: {
            coveredChannelIds: ['front-projector'],
            missingChannelIds: []
          }
        }
      ],
      blockers: [
        {
          id: 'song-present',
          label: 'Communal singing',
          waivable: true,
          status: 'blocker',
          message: 'Check 2',
          evidence: {
            count: 0,
            itemIds: []
          }
        }
      ],
      waivedChecks: []
    }
  );

  assert.throws(
    () => normalizeServiceReadinessReport(
      { ...report, projectId: 'different-service' },
      project
    ),
    /different service contract/
  );
  assert.throws(
    () => normalizeServiceReadinessReport(
      {
        ...report,
        ready: true
      },
      project
    ),
    /internally inconsistent/
  );
  assert.throws(
    () => normalizeServiceReadinessReport(
      {
        ...report,
        projectRevision: 8
      },
      project
    ),
    /internally inconsistent/
  );
});

test('ambiguous exact-sermon ownership remains a normalized non-waivable actionable blocker', () => {
  const {
    normalizeServiceReadinessReport,
    serviceReadinessCandidateHasBlocker
  } = rendererExports();
  const revisionId = 'c'.repeat(64);
  const sermonRevisionId = 'd'.repeat(64);
  const sermonResourceId = `sha256:${sermonRevisionId}`;
  const project = {
    id: 'service-2026-08-16',
    revision: 9,
    channelIds: ['front-projector'],
    planning: { status: 'planning' }
  };
  const report = {
    schemaVersion: 1,
    kind: 'syncshow-service-readiness-report',
    projectId: project.id,
    projectRevision: project.revision,
    projectContentHash: revisionId,
    cueCount: 4,
    ready: false,
    planning: { present: true, status: 'planning' },
    checks: [
      {
        id: 'compilable-nonempty',
        waivable: false,
        status: 'pass',
        message: 'The native service compiles.',
        evidence: { cueCount: 4, compilationCode: null }
      },
      {
        id: 'song-present',
        waivable: true,
        status: 'pass',
        message: 'A song is present.',
        evidence: { count: 1, itemIds: ['song-item'] }
      },
      {
        id: 'exact-sermon-link',
        waivable: false,
        status: 'blocker',
        message:
          'Each exact sermon revision must have one unambiguous sermon material set.',
        evidence: {
          count: 1,
          sermonRevisionIds: [sermonRevisionId],
          ambiguousOwnerSets: [{
            resourceId: sermonResourceId,
            itemIds: ['sermon-owner-a', 'sermon-owner-b']
          }]
        }
      },
      {
        id: 'linked-sermon-material',
        waivable: true,
        status: 'pass',
        message: 'Sermon material is present.',
        evidence: { count: 1, itemIds: ['sermon-material'] }
      },
      {
        id: 'sermon-reading-before-material',
        waivable: true,
        status: 'pass',
        message: 'The sermon reading precedes its material.',
        evidence: {
          count: 1,
          itemIds: ['sermon-reading'],
          requiredSermonResourceIds: [sermonResourceId],
          missingSermonResourceIds: []
        }
      },
      {
        id: 'channel-visible-content',
        waivable: true,
        status: 'pass',
        message: 'Every output has visible content.',
        evidence: {
          coveredChannelIds: ['front-projector'],
          missingChannelIds: []
        }
      }
    ]
  };

  const normalized = normalizeServiceReadinessReport(report, project);
  const exactSermon = normalized.checks[2];
  assert.equal(exactSermon.id, 'exact-sermon-link');
  assert.equal(exactSermon.status, 'blocker');
  assert.equal(exactSermon.waivable, false);
  assert.deepEqual(
    plain(exactSermon.evidence.ambiguousOwnerSets),
    [{
      resourceId: sermonResourceId,
      itemIds: ['sermon-owner-a', 'sermon-owner-b']
    }]
  );
  assert.equal(
    serviceReadinessCandidateHasBlocker(normalized, {
      'exact-sermon-link': 'This must never turn the hard stop into a waiver.'
    }),
    true
  );

  const actions = resolveWeeklyReadinessActions(normalized, {
    projectId: project.id,
    projectRevision: project.revision,
    revisionId
  });
  assert.equal(actions.actions.length, 1);
  assert.equal(actions.primaryAction, actions.actions[0]);
  assert.deepEqual(
    plain(actions.primaryAction),
    {
      checkId: 'exact-sermon-link',
      label: 'Exact sermon packet',
      actionLabel: 'Review sermon sections',
      targetKind: 'weekly-sermon',
      projectId: project.id,
      projectRevision: project.revision,
      revisionId,
      detail:
        'This exact sermon revision appears in more than one sermon material set. Review the sermon sections and keep one unambiguous owner.'
    }
  );
});

test('persisted Community provenance renders as a bounded offline-local identity projection', () => {
  const { projectCommunityPlanningOrigin } = rendererExports();
  const revision =
    '9d73af745137903e781dd3ebd327ca1f2a50a9ef5d775a01375b9ee8663d04e0';
  const project = {
    planning: {
      source: {
        kind: 'community-plan',
        serverId: 'smoke-church',
        planId: 'service-a52cd425-c467-48fd-b1b0-f4cd4723729d',
        planRevision: revision,
        importedAt: '2026-07-29T19:06:26.441Z',
        accessToken: 'must-never-project'
      }
    }
  };

  assert.deepEqual(
    plain(projectCommunityPlanningOrigin(project)),
    {
      serverId: 'smoke-church',
      planId: 'service-a52cd425-c467-48fd-b1b0-f4cd4723729d',
      planRevision: revision,
      shortPlanRevision: '9d73af745137…',
      importedAt: '2026-07-29T19:06:26.441Z'
    }
  );
  assert.equal(
    Object.hasOwn(projectCommunityPlanningOrigin(project), 'accessToken'),
    false
  );
  assert.equal(
    projectCommunityPlanningOrigin({
      planning: {
        source: {
          ...project.planning.source,
          planRevision: revision.toUpperCase()
        }
      }
    }),
    null
  );
  assert.equal(
    projectCommunityPlanningOrigin({
      planning: {
        source: {
          ...project.planning.source,
          planId: `service-${'x'.repeat(128)}`
        }
      }
    }),
    null
  );

  for (const id of [
    'preparePlanningOrigin',
    'preparePlanningOriginPlan',
    'preparePlanningOriginServer',
    'preparePlanningOriginRevision',
    'preparePlanningOriginImported'
  ]) {
    assert.equal(
      (htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length,
      1,
      `${id} must be unique`
    );
  }
  const originBlock = htmlSource.slice(
    htmlSource.indexOf('<aside id="preparePlanningOrigin"'),
    htmlSource.indexOf('</aside>', htmlSource.indexOf(
      '<aside id="preparePlanningOrigin"'
    )) + 8
  );
  assert.match(originBlock, /Offline local copy/);
  assert.match(originBlock, /stays available offline/);
  assert.match(originBlock, /does not require a Community connection/);
  assert.match(originBlock, /does not refresh it in the background/);
  assert.doesNotMatch(originBlock, /token|credential|password|secret/i);
  assert.match(
    controllerSource,
    /const communityOrigin = projectCommunityPlanningOrigin\(project\);[\s\S]*elements\.planningOrigin\.hidden = !communityOrigin/
  );
  assert.match(
    controllerSource,
    /elements\.planningOriginRevision\.textContent =[\s\S]*communityOrigin\.shortPlanRevision/
  );
  assert.match(
    controllerSource,
    /elements\.planningOriginImported\.dateTime = communityOrigin\.importedAt/
  );
});

test('flat rundown rows expose semantic groups, hierarchy metadata, and truthful sermon anchors', () => {
  const { rundownRowPresentation } = rendererExports();
  const sermonResourceId = `sha256:${'7'.repeat(64)}`;
  const project = {
    items: {
      section: {
        id: 'section',
        kind: 'group',
        groupKind: 'section',
        title: 'Scripture and sermon',
        childIds: ['sermon-anchor']
      },
      'sermon-anchor': {
        id: 'sermon-anchor',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Faithful Prayer',
        sermonResourceId,
        childIds: ['point', 'sermon-slide']
      },
      point: {
        id: 'point',
        kind: 'group',
        groupKind: 'point',
        title: 'Prayer strengthens the church',
        childIds: ['subpoint']
      },
      subpoint: {
        id: 'subpoint',
        kind: 'group',
        groupKind: 'subpoint',
        title: 'Rooted in love',
        childIds: ['sermon-note']
      },
      'sermon-slide': {
        id: 'sermon-slide',
        kind: 'sermon',
        title: 'Faithful prayer',
        textByChannel: { english: 'Faithful prayer' }
      },
      'sermon-note': {
        id: 'sermon-note',
        kind: 'notice',
        title: 'Remember',
        textByChannel: { english: 'Remember' }
      }
    },
    resources: {
      [sermonResourceId]: {
        id: sermonResourceId,
        kind: 'sermon'
      }
    }
  };
  const row = (itemId, parentTitles) => ({
    item: project.items[itemId],
    parentTitles
  });

  assert.equal(
    rundownRowPresentation(project, row('section', [])).kindLabel,
    'Section'
  );
  assert.equal(
    rundownRowPresentation(
      project,
      row('point', ['Scripture and sermon', 'Faithful Prayer'])
    ).kindLabel,
    'Sermon point'
  );
  assert.equal(
    rundownRowPresentation(
      project,
      row('subpoint', [
        'Scripture and sermon',
        'Faithful Prayer',
        'Prayer strengthens the church'
      ])
    ).kindLabel,
    'Sermon subpoint'
  );
  const sermon = plain(rundownRowPresentation(
    project,
    row('sermon-anchor', ['Scripture and sermon'])
  ));
  assert.deepEqual(sermon, {
    kindLabel: 'Sermon packet',
    parentPath: 'Scripture and sermon',
    projectedCount: 2,
    summary:
      'Inside Scripture and sermon · 2 projected items · Exact sermon packet linked · Anchor not projected',
    accessibleName:
      'Sermon packet: Faithful Prayer. Inside Scripture and sermon. 2 projected items. Exact sermon packet linked. Anchor not projected.'
  });
  const unlinked = rundownRowPresentation(
    {
      ...project,
      resources: {}
    },
    row('sermon-anchor', ['Scripture and sermon'])
  );
  assert.match(unlinked.summary, /No exact sermon packet linked/);
  assert.doesNotMatch(unlinked.summary, /Exact sermon packet linked/);

  for (const attribute of [
    'aria-level',
    'aria-posinset',
    'aria-setsize',
    'aria-expanded'
  ]) {
    assert.match(
      controllerSource,
      new RegExp(`listItem\\.setAttribute\\([\\s\\S]{0,120}'${attribute}'`)
    );
  }
  assert.match(
    controllerSource,
    /button\.setAttribute\('aria-label', presentation\.accessibleName\)/
  );
  assert.match(
    controllerSource,
    /createElement\('span', 'prepare-item-kind', presentation\.kindLabel\)/
  );
});
