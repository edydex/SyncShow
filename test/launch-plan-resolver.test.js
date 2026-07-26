'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LaunchPlanError,
  resolveLaunchPlan
} = require('../src/services/show');

function output(overrides = {}) {
  return {
    id: 'main',
    name: 'Main Screen',
    kind: 'normal',
    displayId: 2,
    expectedRole: 'russian',
    ...overrides
  };
}

function nativePresentation(slideCount = 3) {
  return {
    slideCount,
    sourceType: 'service-project',
    renderer: 'native-cue',
    scenes: Array.from({ length: slideCount }, (_, index) => ({ cueId: `cue-${index}` })),
    assetPaths: {}
  };
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof LaunchPlanError);
    assert.equal(error.code, code);
    return true;
  });
}

test('one loaded deck can launch one output and produces a frozen snapshot', () => {
  const plan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 42 } },
    outputs: [output()],
    decisions: {},
    preferredTimelineRoleId: 'russian'
  });

  assert.deepEqual(plan, {
    timelineRoleId: 'russian',
    totalSlides: 42,
    outputs: [{
      id: 'main',
      name: 'Main Screen',
      displayId: 2,
      renderer: 'slides',
      sourceRoleId: 'russian',
      operatorPreview: false
    }]
  });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.outputs));
  assert.ok(Object.isFrozen(plan.outputs[0]));
});

test('normal and Singer outputs can mirror one loaded deck', () => {
  const plan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 20 } },
    outputs: [
      output(),
      output({
        id: 'english-room', name: 'English Room', displayId: 3, expectedRole: 'english'
      }),
      output({
        id: 'singer', name: 'Singers Screen', kind: 'singer', displayId: 4, expectedRole: 'media'
      })
    ],
    decisions: {
      'english-room': { mode: 'mirror', sourceRole: 'russian' },
      singer: { mode: 'mirror', sourceRole: 'russian' }
    }
  });

  assert.equal(plan.totalSlides, 20);
  assert.deepEqual(plan.outputs.map(item => [item.id, item.renderer, item.sourceRoleId]), [
    ['main', 'slides', 'russian'],
    ['english-room', 'slides', 'russian'],
    ['singer', 'slides', 'russian']
  ]);
  assert.equal(plan.outputs[2].operatorPreview, true);
});

test('Singer can derive current-and-next content from a loaded role', () => {
  const plan = resolveLaunchPlan({
    presentations: { english: { slideCount: 17 } },
    outputs: [output({
      id: 'singer', name: 'Stage Display', kind: 'singer', displayId: 5, expectedRole: 'media'
    })],
    decisions: {
      singer: { mode: 'derive-next-text', sourceRole: 'english' }
    }
  });

  assert.equal(plan.timelineRoleId, 'english');
  assert.equal(plan.outputs[0].renderer, 'singer-current-next');
  assert.equal(plan.outputs[0].sourceRoleId, 'english');
});

test('native services stay live-DOM for direct, mirror, and Singer-derived routes', () => {
  const plan = resolveLaunchPlan({
    presentations: { russian: nativePresentation(3) },
    outputs: [
      output(),
      output({
        id: 'mirror',
        name: 'Mirror',
        displayId: 3,
        expectedRole: 'english'
      }),
      output({
        id: 'singer',
        name: 'Singers',
        kind: 'singer',
        displayId: 4,
        expectedRole: 'media'
      })
    ],
    decisions: {
      mirror: { mode: 'mirror', sourceRole: 'russian' },
      singer: { mode: 'derive-next-text', sourceRole: 'russian' }
    }
  });

  assert.deepEqual(plan.outputs.map(route => ({
    id: route.id,
    renderer: route.renderer,
    nativeVariant: route.nativeVariant || null
  })), [
    { id: 'main', renderer: 'native-cue', nativeVariant: null },
    { id: 'mirror', renderer: 'native-cue', nativeVariant: null },
    { id: 'singer', renderer: 'native-cue', nativeVariant: 'singer-current-next' }
  ]);
});

test('incomplete native presentation state is rejected before output windows launch', () => {
  expectCode('INVALID_NATIVE_PRESENTATION', () => resolveLaunchPlan({
    presentations: {
      russian: {
        ...nativePresentation(2),
        scenes: [{}]
      }
    },
    outputs: [output()]
  }));
});

test('operator previews follow output configuration instead of output names', () => {
  const plan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 17 } },
    outputs: [
      output({ id: 'confidence-monitor', operatorPreview: true }),
      output({ id: 'singer', name: 'Stage Display', kind: 'singer', displayId: 5,
        expectedRole: 'russian', operatorPreview: false })
    ]
  });

  assert.equal(plan.outputs[0].operatorPreview, true);
  assert.equal(plan.outputs[1].operatorPreview, false);

  expectCode('INVALID_OPERATOR_PREVIEW', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 17 } },
    outputs: [output({ operatorPreview: 'yes' })]
  }));
});

test('an output can be disabled for one service without changing its configuration', () => {
  const outputs = [
    output(),
    output({ id: 'singer', name: 'Singers Screen', kind: 'singer', displayId: null, expectedRole: 'media' })
  ];
  const plan = resolveLaunchPlan({
    presentations: { russian: { slideCount: 12 } },
    outputs,
    decisions: { singer: { mode: 'disabled' } }
  });

  assert.deepEqual(plan.outputs.map(item => item.id), ['main']);
  assert.equal(outputs[1].displayId, null);
});

test('direct mode always resolves the configured expected role', () => {
  expectCode('MISSING_PRESENTATION', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output({ expectedRole: 'english' })],
    decisions: { main: { mode: 'direct' } }
  }));

  expectCode('INVALID_DIRECT_SOURCE', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 }, english: { slideCount: 8 } },
    outputs: [output({ expectedRole: 'english' })],
    decisions: { main: { mode: 'direct', sourceRole: 'russian' } }
  }));
});

test('derive-next-text is rejected for a normal output', () => {
  expectCode('DERIVE_REQUIRES_SINGER', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output()],
    decisions: { main: { mode: 'derive-next-text', sourceRole: 'russian' } }
  }));
});

test('missing display assignments and physical display collisions are rejected', () => {
  expectCode('MISSING_DISPLAY', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output({ displayId: null })]
  }));

  expectCode('DISPLAY_COLLISION', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output(), output({ id: 'second', name: 'Second', displayId: '2' })]
  }));
});

test('independently routed decks with different counts never guess alignment', () => {
  expectCode('SLIDE_COUNT_MISMATCH', () => resolveLaunchPlan({
    presentations: {
      russian: { slideCount: 114 },
      english: { slideCount: 113 }
    },
    outputs: [
      output(),
      output({ id: 'english', name: 'English', displayId: 3, expectedRole: 'english' })
    ]
  }));
});

test('equal independently routed decks use the preferred role as timeline authority', () => {
  const plan = resolveLaunchPlan({
    presentations: {
      russian: { slideCount: 114 },
      english: { slideCount: 114 }
    },
    outputs: [
      output(),
      output({ id: 'english', name: 'English', displayId: 3, expectedRole: 'english' })
    ],
    preferredTimelineRoleId: 'english'
  });

  assert.equal(plan.timelineRoleId, 'english');
  assert.equal(plan.totalSlides, 114);
});

test('an unused preferred role cannot become the timeline authority', () => {
  const plan = resolveLaunchPlan({
    presentations: {
      russian: { slideCount: 10 },
      english: { slideCount: 99 }
    },
    outputs: [output()],
    preferredTimelineRoleId: 'english'
  });

  assert.equal(plan.timelineRoleId, 'russian');
  assert.equal(plan.totalSlides, 10);
});

test('no active outputs and invalid loaded slide counts are rejected', () => {
  expectCode('NO_ENABLED_OUTPUTS', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output()],
    decisions: { main: { mode: 'disabled' } }
  }));

  expectCode('INVALID_SLIDE_COUNT', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 0 } },
    outputs: [output()]
  }));
});

test('duplicate output IDs and stale decisions are rejected', () => {
  expectCode('DUPLICATE_OUTPUT_ID', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output(), output({ displayId: 3 })]
  }));

  expectCode('UNKNOWN_DECISION_OUTPUT', () => resolveLaunchPlan({
    presentations: { russian: { slideCount: 8 } },
    outputs: [output()],
    decisions: { removed: { mode: 'disabled' } }
  }));
});
