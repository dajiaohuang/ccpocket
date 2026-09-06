import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_REVIEW_FILES,
  SMALL_PR_FILES,
  ciCheckSha,
  codeRabbitGate,
  deferredCodeRabbitGate,
  evaluateIntake,
  getField,
  getSection,
  isCodeRabbitReviewEligible,
  isHighRiskPath,
  isReviewPolicyPath,
  isUiRelatedPath,
  main,
  requiresReviewPolicyOverride,
  shouldEvaluateCi,
  sizeLabel,
} from './pr-readiness.mjs';

function body(overrides = {}) {
  const values = {
    summary: 'Fix connection recovery after a transient disconnect.',
    related: '#123',
    why: 'The issue and implementation scope are already agreed.',
    changes: '- Retry the connection once.\n- Add regression coverage.',
    primaryGoal: 'Restore a disconnected Bridge session.',
    outOfScope: 'Changing the WebSocket protocol.',
    splitPlan: 'The production change and regression test form one atomic fix.',
    automated: '`npm run test:bridge` — passed.',
    manual: 'Disconnected and reconnected a local test client successfully.',
    platform: 'macOS 15, Node.js 22.',
    risk: 'Low',
    risks: 'A retry could occur once after an intentional disconnect.',
    rollback: 'Revert this PR.',
    noVisual: true,
    textOnly: false,
    visual: false,
    noVisualReason: 'Bridge-only behavior; no mobile rendering changes.',
    before: '',
    after: '',
    device: '',
    ...overrides,
  };
  const checked = (selected) => (selected ? 'x' : ' ');

  return `## Summary

${values.summary}

## Why This Is A PR

- Related Issue / Prompt Request: ${values.related}
- Why this is ready for PR review: ${values.why}

## Changes

${values.changes}

## Scope Check

- Single primary goal: ${values.primaryGoal}
- Intentionally out of scope: ${values.outOfScope}
- Split plan or why this cannot be split: ${values.splitPlan}

## Test Evidence

- Automated tests (command and result): ${values.automated}
- Manual validation: ${values.manual}
- Target platform and version: ${values.platform}

## Risk and Rollback

- [${checked(values.risk === 'Low')}] Low
- [${checked(values.risk === 'Medium')}] Medium
- [${checked(values.risk === 'High')}] High
- Main risks: ${values.risks}
- Rollback plan: ${values.rollback}

## UI Evidence

- [${checked(values.noVisual)}] No user-visible UI change
- [${checked(values.textOnly)}] User-visible text-only change
- [${checked(values.visual)}] Visual or interaction UI change
- No-visual-change reason: ${values.noVisualReason}
- Before: ${values.before}
- After: ${values.after}
- Device / platform: ${values.device}

## Author Checklist

- [x] I reviewed the complete diff and can explain and maintain this change.
- [x] This PR contains no unrelated changes.
- [x] User-facing or breaking changes are documented, or documentation is not applicable.
`;
}

test('extracts markdown sections and multiline fields', () => {
  const source = `${body()}\n`;
  const section = getSection(source, 'Test Evidence');
  assert.match(section, /npm run test:bridge/);
  assert.equal(
    getField(section, 'Target platform and version'),
    'macOS 15, Node.js 22.',
  );
});

test('accepts CRLF line endings from GitHub web form edits', () => {
  const result = evaluateIntake({
    body: body().replace(/\n/g, '\r\n'),
    files: ['apps/mobile/lib/features/settings/state/settings_cubit.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('accepts a complete non-UI PR', () => {
  const result = evaluateIntake({
    body: body(),
    files: ['packages/bridge/src/session.ts', 'packages/bridge/src/session.test.ts'],
    fileCount: 2,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.uiRelated, false);
  assert.equal(result.size, 'size:S');
});

test('treats supporting context as advisory for a small low-risk PR', () => {
  const result = evaluateIntake({
    body: body({
      why: '',
      outOfScope: '',
      splitPlan: '',
      manual: '',
      platform: '',
    }),
    files: ['apps/mobile/lib/features/settings/state/settings_cubit.dart'],
    fileCount: SMALL_PR_FILES,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.lightweight, true);
  assert.equal(result.warnings.length, 5);
});

test('keeps supporting context mandatory for high-risk PRs', () => {
  const result = evaluateIntake({
    body: body({ manual: '' }),
    files: ['packages/bridge/src/websocket.ts'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('Manual validation')));
  assert.equal(result.lightweight, false);
});

test('keeps supporting context mandatory when the author selects high risk', () => {
  const result = evaluateIntake({
    body: body({ risk: 'High', manual: '' }),
    files: ['docs/maintenance.md'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('Manual validation')));
  assert.equal(result.highRisk, true);
  assert.equal(result.lightweight, false);
});

test('keeps supporting context mandatory above the small PR limit', () => {
  const result = evaluateIntake({
    body: body({ splitPlan: '' }),
    files: Array.from({ length: SMALL_PR_FILES + 1 }, (_, index) =>
      `docs/file-${index}.md`,
    ),
    fileCount: SMALL_PR_FILES + 1,
  });
  assert.ok(result.errors.some((error) => error.includes('Split plan')));
  assert.equal(result.lightweight, false);
});

test('requires a reason when mobile files claim no visual change', () => {
  const result = evaluateIntake({
    body: body({ noVisualReason: '' }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('no user-visible change')));
});

test('requires before and after attachments for a visual change', () => {
  const result = evaluateIntake({
    body: body({ noVisual: false, visual: true, noVisualReason: '' }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('Before image')));
  assert.ok(result.errors.some((error) => error.includes('After image')));
});

test('accepts automated test evidence instead of images for a text-only change', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; a focused widget test verifies the localized copy.',
      automated: '`flutter test test/error_test.dart` — passed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('requires a reason when a text-only change omits images', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: '',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test evidence')));
});

test('requires automated UI test evidence for a text-only change', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`npm run test:bridge` — passed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('rejects failed automated UI test evidence for a text-only change', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/error_test.dart` — failed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('rejects negated success evidence for a text-only change', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/error_test.dart` — not passed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('rejects mixed passing and failing UI test evidence', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/error_test.dart` — 1 passed, 1 failed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('accepts an explicit zero-failure UI test result', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/error_test.dart` — 1 passed, 0 failed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('accepts a passing UI test whose filename contains failure', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/failure_banner_test.dart` — passed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('rejects a passing filename without an explicit test result', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: '`flutter test test/passing-banner-test.dart`',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('rejects a UI test claim without the executed flutter command', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: 'Existing error surface only; there is no layout change.',
      automated: 'The widget test passed.',
    }),
    files: ['apps/mobile/lib/features/session_list/session_list_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test command')));
});

test('requires a text-only reason even outside mobile UI paths', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      textOnly: true,
      noVisualReason: '',
      automated: '`flutter test test/error_test.dart` — passed.',
    }),
    files: ['packages/bridge/src/session.ts'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('automated UI test evidence')));
});

test('keeps accepting the legacy visible UI option', () => {
  const legacyBody = body({
    noVisual: false,
    visual: true,
    noVisualReason: '',
    before: 'N/A — this screen is new.',
    after: '![New screen](https://github.com/user-attachments/assets/example)',
    device: 'iPhone 16 Pro, iOS 18.',
  }).replace('Visual or interaction UI change', 'User-visible UI change');
  const result = evaluateIntake({
    body: legacyBody,
    files: ['apps/mobile/lib/features/example/example_screen.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('rejects selecting both current and legacy visible UI options', () => {
  const duplicateVisualBody = body({
    noVisual: false,
    visual: true,
    noVisualReason: '',
    before: 'N/A — this screen is new.',
    after: '![New screen](https://github.com/user-attachments/assets/example)',
    device: 'iPhone 16 Pro, iOS 18.',
  }).replace(
    '- [x] Visual or interaction UI change',
    '- [x] Visual or interaction UI change\n- [x] User-visible UI change',
  );
  const result = evaluateIntake({
    body: duplicateVisualBody,
    files: ['apps/mobile/lib/features/example/example_screen.dart'],
    fileCount: 1,
  });
  assert.ok(result.errors.some((error) => error.includes('exactly one UI Evidence')));
});

test('accepts N/A with reason for a new UI and an uploaded After image', () => {
  const result = evaluateIntake({
    body: body({
      noVisual: false,
      visual: true,
      noVisualReason: '',
      before: 'N/A — this screen is new.',
      after: '![New screen](https://github.com/user-attachments/assets/example)',
      device: 'iPhone 16 Pro, iOS 18.',
    }),
    files: ['apps/mobile/lib/features/example/example_screen.dart'],
    fileCount: 1,
  });
  assert.deepEqual(result.errors, []);
});

test('requires a linked issue for PRs changing more than 50 files', () => {
  const result = evaluateIntake({
    body: body({ related: 'None — isolated maintenance change.' }),
    files: Array.from({ length: 51 }, (_, index) => `docs/file-${index}.md`),
    fileCount: 51,
  });
  assert.ok(result.errors.some((error) => error.includes('must link a prior Issue')));
  assert.equal(result.size, 'size:L');
});

test('rejects a bare N/A in a required validation field', () => {
  const result = evaluateIntake({
    body: body({ automated: 'N/A' }),
    files: ['docs/maintenance.md'],
    fileCount: 1,
  });
  assert.ok(
    result.errors.some((error) =>
      error.includes('Automated tests (command and result)'),
    ),
  );
});

test('rejects PRs above the hard file limit before parsing the body', () => {
  const result = evaluateIntake({
    body: '',
    files: [],
    fileCount: MAX_REVIEW_FILES + 1,
  });
  assert.equal(result.oversized, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.size, 'size:XL');
});

test('stops quality-held PRs before parsing the body or requiring more evidence', () => {
  const result = evaluateIntake({
    body: '',
    files: [],
    fileCount: 2,
    qualityHold: true,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /status:quality-hold/);
  assert.equal(result.oversized, false);
  assert.equal(isCodeRabbitReviewEligible({
    draft: false,
    oversized: result.oversized,
    intakePassed: result.errors.length === 0,
    override: false,
  }), false);
});

test('keeps the size gate first even for quality-held PRs', () => {
  const result = evaluateIntake({
    body: '', files: [], fileCount: MAX_REVIEW_FILES + 1, qualityHold: true,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /split it/);
});

test('quality hold removes readiness without reading patches or closing the PR, and can be cleared', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpocket-readiness-'));
  const eventPath = path.join(directory, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42 } }));
  const environment = {
    GITHUB_TOKEN: 'test-only-token', GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'example/repo', MAINTAINER_LOGIN: 'maintainer',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const labels = new Set(['size:S', 'status:quality-hold', 'ready-for-maintainer-review', 'review:coderabbit']);
  const requests = [];
  const base = '/repos/example/repo';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = decodeURIComponent(new URL(url).pathname);
    const method = options.method;
    const payload = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ route, method, payload });
    let response;
    if (method === 'GET') {
      if (route === `${base}/labels`) response = [...labels].map((name) => ({ name }));
      else if (route === `${base}/pulls/42`) response = {
        number: 42, state: 'open', draft: false, changed_files: 2, body: body(),
        labels: [...labels].map((name) => ({ name })), head: { sha: 'head-sha' },
        user: { login: 'contributor' }, requested_reviewers: [{ login: 'maintainer' }],
        html_url: 'https://github.com/example/repo/pull/42',
      };
      else if (route === `${base}/commits/head-sha/check-runs`) response = {
        check_runs: ['repository', 'mobile', 'bridge', 'functions'].map((name) => ({
          name, status: 'completed', conclusion: 'success',
        })),
      };
      else if (route === `${base}/issues/42/comments`) response = [];
      else if (route === `${base}/commits/head-sha/status`) response = { statuses: [] };
      else if (route === `${base}/pulls/42/files`) response = [{ filename: 'docs/fix.md' }];
      else if (route === `${base}/pulls/42/reviews`) response = [rabbitReview()];
      else if (route === `${base}/commits/head-sha/statuses`) response = completedRabbitStatus;
      else assert.fail(`Unexpected GET ${route}`);
    } else {
      if (route === `${base}/issues/42/labels` && method === 'POST') {
        for (const label of payload.labels) labels.add(label);
      } else if (route.startsWith(`${base}/issues/42/labels/`) && method === 'DELETE') {
        labels.delete(route.slice(`${base}/issues/42/labels/`.length));
      }
      response = {};
    }
    return new Response(JSON.stringify(response), { status: 200 });
  });

  await main();
  assert.ok(labels.has('status:quality-hold'));
  assert.ok(labels.has('status:needs-author'));
  assert.ok(!labels.has('ready-for-maintainer-review'));
  assert.ok(!labels.has('review:coderabbit'));
  assert.ok(!requests.some(({ route }) => /\/42\/(?:files|reviews)$/.test(route)));
  assert.ok(!requests.some(({ method, payload }) => method === 'PATCH' && payload.state === 'closed'));
  assert.ok(requests.some(({ route, method }) => route.endsWith('/requested_reviewers') && method === 'DELETE'));
  assert.ok(requests.some(({ route, payload }) => route.endsWith('/statuses/head-sha') && payload.state === 'failure'));

  // An override for other gates cannot substitute for explicitly clearing the hold.
  labels.add('review:override');
  requests.length = 0;
  await main();
  assert.ok(labels.has('status:quality-hold'));
  assert.ok(!labels.has('ready-for-maintainer-review'));
  assert.ok(!labels.has('review:coderabbit'));
  assert.ok(!requests.some(({ route }) => /\/42\/(?:files|reviews)$/.test(route)));
  assert.ok(requests.some(({ route, payload }) => route.endsWith('/statuses/head-sha') && payload.state === 'failure'));

  // A maintainer clears the hold; the same green CI and real head approval now qualify.
  labels.delete('review:override');
  labels.delete('status:quality-hold');
  requests.length = 0;
  await main();
  assert.ok(labels.has('ready-for-maintainer-review'));
  assert.ok(labels.has('review:coderabbit'));
  assert.ok(!labels.has('status:needs-author'));
  assert.ok(requests.some(({ route, payload }) => route.endsWith('/statuses/head-sha') && payload.state === 'success'));
});

test('classifies generated UI files and high-risk paths', () => {
  assert.equal(isUiRelatedPath('apps/mobile/lib/router/app_router.gr.dart'), false);
  assert.equal(isUiRelatedPath('apps/mobile/lib/features/chat/chat_screen.dart'), true);
  assert.equal(isHighRiskPath('.github/workflows/release.yml'), true);
  assert.equal(isHighRiskPath('.coderabbit.yaml'), true);
  assert.equal(isHighRiskPath('packages/bridge/src/websocket.ts'), true);
  assert.equal(isHighRiskPath('docs/architecture.md'), false);
  assert.equal(isReviewPolicyPath('.coderabbit.yaml'), true);
  assert.equal(isReviewPolicyPath('.github/workflows/test.yml'), true);
  assert.equal(isReviewPolicyPath('scripts/pr-readiness.mjs'), true);
  assert.equal(isReviewPolicyPath('CLAUDE.md'), true);
  assert.equal(isReviewPolicyPath('.claude/agents/code-reviewer.md'), true);
  assert.equal(isReviewPolicyPath('.codex/rules/default.rules'), true);
  assert.equal(isReviewPolicyPath('packages/bridge/src/session.ts'), false);
  assert.equal(sizeLabel(10), 'size:S');
  assert.equal(sizeLabel(11), 'size:M');
  assert.equal(sizeLabel(51), 'size:L');
  assert.equal(sizeLabel(151), 'size:XL');
});

test('requires maintainer override for external review-policy changes', () => {
  const policyChange = {
    files: ['.coderabbit.yaml'],
    author: 'external-contributor',
    maintainer: 'K9i-0',
  };
  assert.equal(requiresReviewPolicyOverride({ ...policyChange, override: false }), true);
  assert.equal(requiresReviewPolicyOverride({ ...policyChange, override: true }), false);
  assert.equal(
    requiresReviewPolicyOverride({
      ...policyChange,
      author: 'K9i-0',
      override: false,
    }),
    false,
  );
});

test('evaluates CI independently from intake readiness', () => {
  assert.equal(
    shouldEvaluateCi({ oversized: false, override: false, intakePassed: false }),
    true,
  );
  assert.equal(shouldEvaluateCi({ oversized: true, override: false }), false);
  assert.equal(shouldEvaluateCi({ oversized: true, override: true }), true);
});

test('reads Test check runs from the PR head commit', () => {
  assert.equal(
    ciCheckSha({
      head: { sha: 'head-sha' },
      merge_commit_sha: 'temporary-merge-sha',
    }),
    'head-sha',
  );
  assert.equal(ciCheckSha({}), null);
});

test('explains why CodeRabbit was not requested', () => {
  assert.deepEqual(
    deferredCodeRabbitGate({
      draft: true,
      oversized: false,
      intakePassed: true,
      override: false,
    }),
    { state: 'pending', detail: 'Not requested while the PR is a draft.' },
  );
  assert.deepEqual(
    deferredCodeRabbitGate({
      draft: false,
      oversized: false,
      intakePassed: false,
      override: false,
    }),
    { state: 'pending', detail: 'Not requested until intake passes.' },
  );
  assert.deepEqual(
    deferredCodeRabbitGate({
      draft: false,
      oversized: false,
      intakePassed: false,
      override: true,
    }),
    { state: 'skipped', detail: 'Skipped by maintainer override.' },
  );
});

function rabbitReview(state = 'APPROVED', commit = 'head-sha', minute = '00') {
  return {
    user: { login: 'coderabbitai[bot]' },
    commit_id: commit,
    state,
    submitted_at: `2026-08-29T00:${minute}:00Z`,
  };
}

const completedRabbitStatus = [{
  context: 'CodeRabbit', state: 'success', description: 'Review completed',
}];

test('requires explicit approval even when the CodeRabbit status is completed', () => {
  assert.deepEqual(
    codeRabbitGate(
      [],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
        },
      ],
      'head-sha',
    ),
    {
      state: 'pending',
      detail: 'Waiting for CodeRabbit review and approval on the latest commit.',
    },
  );
});

test('does not accept a skipped CodeRabbit success status', () => {
  assert.deepEqual(
    codeRabbitGate(
      [rabbitReview()],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review skipped: excluded by label configuration',
        },
      ],
      'head-sha',
    ),
    {
      state: 'pending',
      detail: 'Waiting for CodeRabbit review and approval on the latest commit.',
    },
  );
});

test('requires an exact CodeRabbit review-completed description', () => {
  assert.deepEqual(
    codeRabbitGate(
      [rabbitReview()],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed: review skipped',
        },
      ],
      'head-sha',
    ),
    {
      state: 'pending',
      detail: 'Waiting for CodeRabbit review and approval on the latest commit.',
    },
  );
});

test('rejects a CodeRabbit context status from an explicitly foreign creator', () => {
  assert.deepEqual(
    codeRabbitGate(
      [rabbitReview()],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
          creator: { login: 'unrelated-bot' },
        },
      ],
      'head-sha',
    ),
    {
      state: 'pending',
      detail: 'Waiting for CodeRabbit review and approval on the latest commit.',
    },
  );
});

test('finds a CodeRabbit status after the first API page', () => {
  const statuses = Array.from({ length: 100 }, (_, index) => ({
    context: `other-check-${index}`,
    state: 'success',
    description: 'Completed',
  }));
  statuses.push({
    context: 'CodeRabbit',
    state: 'success',
    description: 'Review completed',
  });

  assert.equal(codeRabbitGate([rabbitReview()], statuses, 'head-sha').state, 'success');
});

test('uses the latest CodeRabbit status when older completed statuses remain', () => {
  assert.deepEqual(
    codeRabbitGate(
      [rabbitReview()],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
          updated_at: '2026-08-29T00:00:00Z',
        },
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review skipped: excluded by label configuration',
          updated_at: '2026-08-29T00:01:00Z',
        },
      ],
      'head-sha',
    ),
    {
      state: 'pending',
      detail: 'Waiting for CodeRabbit review and approval on the latest commit.',
    },
  );
});

test('keeps latest CodeRabbit change requests blocking', () => {
  assert.deepEqual(
    codeRabbitGate(
      [
        {
          user: { login: 'coderabbitai' },
          commit_id: 'head-sha',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-29T00:00:00Z',
        },
      ],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
        },
      ],
      'head-sha',
    ),
    { state: 'failure', detail: 'Resolve CodeRabbit change requests.' },
  );
});

test('does not let a late old-commit review hide head change requests', () => {
  assert.deepEqual(
    codeRabbitGate(
      [
        {
          user: { login: 'coderabbitai' },
          commit_id: 'head-sha',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-29T00:00:00Z',
        },
        {
          user: { login: 'coderabbitai' },
          commit_id: 'old-sha',
          state: 'APPROVED',
          submitted_at: '2026-08-29T00:01:00Z',
        },
      ],
      [
        {
          context: 'CodeRabbit',
          state: 'success',
          description: 'Review completed',
        },
      ],
      'head-sha',
    ),
    { state: 'failure', detail: 'Resolve CodeRabbit change requests.' },
  );
});

test('accepts an explicit head approval after a completed review', () => {
  assert.equal(
    codeRabbitGate([rabbitReview()], completedRabbitStatus, 'head-sha').state,
    'success',
  );
});

test('does not accept approval from an unrelated reviewer or an old commit', () => {
  for (const review of [
    { ...rabbitReview(), user: { login: 'external-contributor' } },
    rabbitReview('APPROVED', 'old-sha'),
    rabbitReview('DISMISSED'),
  ]) {
    assert.equal(codeRabbitGate([review], completedRabbitStatus, 'head-sha').state, 'pending');
  }
});

test('requires a completed review even after an explicit approval command', () => {
  for (const statuses of [[], [{ context: 'CodeRabbit', state: 'pending' }]]) {
    assert.equal(codeRabbitGate([rabbitReview()], statuses, 'head-sha').state, 'pending');
  }
  assert.equal(codeRabbitGate(
    [rabbitReview()], [{ context: 'CodeRabbit', state: 'failure' }], 'head-sha',
  ).state, 'failure');
});

test('does not let commentary clear a change request or invalidate an approval', () => {
  for (const [state, expected] of [['APPROVED', 'success'], ['CHANGES_REQUESTED', 'failure']]) {
    assert.equal(codeRabbitGate([
      rabbitReview(state),
      rabbitReview('COMMENTED', 'head-sha', '01'),
    ], completedRabbitStatus, 'head-sha').state, expected);
  }
});

test('keeps old-head change requests blocking until a new approval supersedes them', () => {
  const requested = rabbitReview('CHANGES_REQUESTED', 'old-sha');
  assert.equal(codeRabbitGate([requested], completedRabbitStatus, 'head-sha').state, 'failure');
  assert.equal(codeRabbitGate([
    requested, rabbitReview('APPROVED', 'head-sha', '01'),
  ], completedRabbitStatus, 'head-sha').state, 'success');
});

test('blocks a late change request on an old head after the head was approved', () => {
  assert.equal(codeRabbitGate([
    rabbitReview(), rabbitReview('CHANGES_REQUESTED', 'old-sha', '01'),
  ], completedRabbitStatus, 'head-sha').state, 'failure');
});

test('does not reuse an earlier approval after a later head review is dismissed', () => {
  assert.equal(codeRabbitGate([
    rabbitReview(), rabbitReview('DISMISSED', 'head-sha', '01'),
  ], completedRabbitStatus, 'head-sha').state, 'pending');
});

test('does not request CodeRabbit when a maintainer override applies', () => {
  assert.equal(
    isCodeRabbitReviewEligible({
      draft: false,
      oversized: false,
      intakePassed: true,
      override: true,
    }),
    false,
  );
  assert.equal(
    isCodeRabbitReviewEligible({
      draft: false,
      oversized: false,
      intakePassed: true,
      override: false,
    }),
    true,
  );
});
