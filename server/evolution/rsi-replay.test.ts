import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BASELINE_RULES, DEFAULT_RSI_BUDGET, DEMO_CASES, MAX_RSI_CASES, MAX_RSI_RULES,
  ReplayReportSchema, RsiCasesSchema, RsiInputSchema, RsiRulesSchema,
  classify, proposeRules, runReplay,
  type RsiCase, type RsiRules,
} from './rsi-replay.js';

const adaptive = DEMO_CASES.filter((item) => item.slice === 'adaptive');
function demoReplay(activeRules: RsiRules, candidateRules: RsiRules, noRetentionRules = BASELINE_RULES) {
  return runReplay({ cases: DEMO_CASES, activeRules, candidateRules, noRetentionRules, budget: DEFAULT_RSI_BUDGET });
}

test('bounded interpreter recognizes only declarative known inputs and applies the same ordered rules', () => {
  assert.equal(classify({ httpStatus: 401 }, BASELINE_RULES).reason, 'auth_denied');
  assert.equal(classify({ errorCode: 'ETIMEDOUT' }, BASELINE_RULES).reason, 'unknown');
  assert.deepEqual(classify({ httpStatus: 404 }, BASELINE_RULES, 1), {
    reason: 'unknown', matchedRuleId: null, ruleChecks: 1, truncated: true,
  });
  assert.equal(RsiInputSchema.safeParse({ errorCode: 'eval(arbitrary)' }).success, false);
  assert.equal(RsiInputSchema.safeParse({ httpStatus: 999 }).success, false);
  assert.equal(RsiInputSchema.safeParse({ httpStatus: 504, script: 'process.exit()' }).success, false);
  assert.equal(RsiRulesSchema.safeParse([{ id: 'anything', predicate: {}, reason: 'unknown' }]).success, false);
});

test('one proposal reads only adaptive labels and generalizes to a distinct held-out HTTP status', () => {
  const proposal = proposeRules(adaptive, BASELINE_RULES);
  assert.equal(proposal.status, 'proposed');
  assert.deepEqual(proposal.addedRule?.predicate, { errorCode: 'ETIMEDOUT' });
  assert.deepEqual(proposal.evidenceCaseIds, ['adaptive.timeout']);
  assert.deepEqual(proposal.rules.slice(1), BASELINE_RULES);
  assert.equal(classify({ httpStatus: 408, errorCode: 'ETIMEDOUT' }, proposal.rules).reason, 'timeout');
  assert.throws(() => proposeRules(DEMO_CASES, BASELINE_RULES), /only adaptive/);
  assert.throws(() => proposeRules(DEMO_CASES.filter((item) => item.slice === 'holdout'), BASELINE_RULES), /only adaptive/);
  // Proposal results cannot depend on labels the caller keeps outside the adaptive API.
  const changedHoldout: RsiCase[] = DEMO_CASES.map((item) => item.slice === 'holdout' ? { ...item, expectedReason: 'auth_denied' } : item);
  assert.deepEqual(proposeRules(changedHoldout.filter((item) => item.slice === 'adaptive'), BASELINE_RULES), proposal);
});

test('two rounds retain the first learned rule and outperform an equally proposed reset control', () => {
  const first = proposeRules(adaptive, BASELINE_RULES);
  const firstReset = proposeRules(adaptive, BASELINE_RULES);
  const firstReplay = demoReplay(BASELINE_RULES, first.rules, firstReset.rules);
  assert.equal(firstReplay.gate.passed, true);
  assert.equal(firstReplay.scenarios.active.slices.adaptive.accuracy, 0);
  assert.equal(firstReplay.scenarios.candidate.slices.adaptive.accuracy, 0.5);
  assert.equal(firstReplay.retention.adaptive.accuracyDelta, 0);

  const second = proposeRules(adaptive, first.rules);
  const secondReset = proposeRules(adaptive, BASELINE_RULES);
  const secondReplay = demoReplay(first.rules, second.rules, secondReset.rules);
  assert.equal(second.addedRule?.reason, 'rate_limited');
  assert.deepEqual(second.rules.slice(1), first.rules);
  assert.equal(secondReplay.gate.passed, true);
  assert.equal(secondReplay.scenarios.active.slices.holdout.accuracy, 0.5);
  assert.equal(secondReplay.scenarios.candidate.slices.adaptive.accuracy, 1);
  assert.equal(secondReplay.scenarios.candidate.slices.holdout.accuracy, 1);
  assert.equal(secondReplay.scenarios.noRetention.slices.adaptive.accuracy, 0.5);
  assert.equal(secondReplay.retention.adaptive.accuracyDelta, 0.5);
  assert.deepEqual(secondReplay.retention.holdout.improvedCaseIds, ['holdout.rate']);
  assert.deepEqual(proposeRules(adaptive, second.rules).status, 'no_change');
  assert.deepEqual(runReplay({ cases: DEMO_CASES, activeRules: first.rules, candidateRules: second.rules, noRetentionRules: secondReset.rules, budget: DEFAULT_RSI_BUDGET }), secondReplay);
  assert.deepEqual(ReplayReportSchema.parse(secondReplay), secondReplay);
});

test('frozen regressions reject a proposal even if adaptive and holdout accuracy improve', () => {
  const cases: RsiCase[] = [
    { id: 'frozen.original', slice: 'frozen', input: { httpStatus: 401, errorCode: 'ETIMEDOUT' }, expectedReason: 'auth_denied', source: 'operator' },
    { id: 'adaptive.new', slice: 'adaptive', input: { httpStatus: 504, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
    { id: 'holdout.new', slice: 'holdout', input: { httpStatus: 408, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
  ];
  const proposal = proposeRules(cases.filter((item) => item.slice === 'adaptive'), BASELINE_RULES);
  const report = runReplay({ cases, activeRules: BASELINE_RULES, candidateRules: proposal.rules, noRetentionRules: BASELINE_RULES, budget: DEFAULT_RSI_BUDGET });
  assert.equal(report.gate.passed, false);
  assert.deepEqual(report.comparisons.activeToCandidate.frozen.regressedCaseIds, ['frozen.original']);
  assert.ok(report.gate.reasons.includes('frozen_regression'));
  assert.equal(report.comparisons.activeToCandidate.adaptive.accuracyDelta, 1);
  assert.equal(report.comparisons.activeToCandidate.holdout.accuracyDelta, 1);
});

test('holdout regression, absent slices, and zero transfer reject promotion', () => {
  const first = proposeRules(adaptive, BASELINE_RULES);
  const holdoutRegression: RsiCase[] = DEMO_CASES.map((item) => item.id === 'holdout.timeout'
    ? { ...item, input: { httpStatus: 401, errorCode: 'ETIMEDOUT' }, expectedReason: 'auth_denied' }
    : item);
  const regression = runReplay({ cases: holdoutRegression, activeRules: BASELINE_RULES, candidateRules: first.rules, noRetentionRules: BASELINE_RULES, budget: DEFAULT_RSI_BUDGET });
  assert.ok(regression.gate.reasons.includes('holdout_regression'));
  const missing = runReplay({ cases: adaptive, activeRules: BASELINE_RULES, candidateRules: first.rules, noRetentionRules: BASELINE_RULES, budget: DEFAULT_RSI_BUDGET });
  assert.ok(missing.gate.reasons.includes('missing_frozen_cases'));
  assert.ok(missing.gate.reasons.includes('missing_holdout_cases'));
  const unchanged = demoReplay(first.rules, first.rules);
  assert.ok(unchanged.gate.reasons.includes('adaptive_improvement_required'));
  assert.ok(unchanged.gate.reasons.includes('holdout_transfer_required'));
  assert.equal(unchanged.gate.passed, false);
});

test('a positive net adaptive gain cannot hide a regression on an existing adaptive case', () => {
  const cases: RsiCase[] = [
    { id: 'frozen.safe', slice: 'frozen', input: { httpStatus: 404 }, expectedReason: 'not_found', source: 'operator' },
    { id: 'adaptive.old', slice: 'adaptive', input: { httpStatus: 401, errorCode: 'ETIMEDOUT' }, expectedReason: 'auth_denied', source: 'operator' },
    ...[504, 408, 502].map((httpStatus): RsiCase => ({ id: `adaptive.new.${httpStatus}`, slice: 'adaptive', input: { httpStatus, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' })),
    { id: 'holdout.transfer', slice: 'holdout', input: { httpStatus: 503, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
  ];
  const candidateRules: RsiRules = [{ id: 'new.timeout', predicate: { errorCode: 'ETIMEDOUT' }, reason: 'timeout' }, ...BASELINE_RULES];
  const report = runReplay({ cases, activeRules: BASELINE_RULES, candidateRules, noRetentionRules: BASELINE_RULES, budget: DEFAULT_RSI_BUDGET });
  assert.equal(report.comparisons.activeToCandidate.adaptive.accuracyDelta, 0.5);
  assert.deepEqual(report.comparisons.activeToCandidate.adaptive.regressedCaseIds, ['adaptive.old']);
  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.reasons.includes('adaptive_regression'));
});

test('all variants reserve equal per-case computation and no evaluation runs beyond the budget', () => {
  const first = proposeRules(adaptive, BASELINE_RULES);
  const second = proposeRules(adaptive, first.rules);
  const cases = DEMO_CASES;
  const sufficient = { maxRuleChecksPerCase: second.rules.length, maxTotalRuleChecks: cases.length * second.rules.length * 3 };
  const input = { cases, activeRules: first.rules, candidateRules: second.rules, noRetentionRules: first.rules };
  const report = runReplay({ ...input, budget: sufficient });
  assert.equal(report.budget.equalPerCaseLimit, true);
  assert.equal(report.budget.reservedRuleChecks, sufficient.maxTotalRuleChecks);
  assert.equal(report.budget.withinBudget, true);
  assert.ok(report.budget.actualRuleChecks <= report.budget.reservedRuleChecks);
  for (const scenario of Object.values(report.scenarios)) {
    assert.equal(scenario.caseCount, cases.length);
    assert.equal(scenario.evaluated, true);
    assert.deepEqual(scenario.results.map((result) => result.caseId), cases.map((item) => item.id));
    assert.ok(scenario.results.every((result) => result.ruleChecks <= sufficient.maxRuleChecksPerCase));
  }
  const insufficient = runReplay({ ...input, budget: { ...sufficient, maxTotalRuleChecks: sufficient.maxTotalRuleChecks - 1 } });
  assert.equal(insufficient.gate.passed, false);
  assert.equal(insufficient.budget.actualRuleChecks, 0);
  assert.ok(insufficient.gate.reasons.includes('comparison_budget_exceeded'));
  for (const scenario of Object.values(insufficient.scenarios)) {
    assert.equal(scenario.evaluated, false);
    assert.equal(scenario.accuracy, null);
  }
  const shortPerCase = runReplay({ ...input, budget: { ...sufficient, maxRuleChecksPerCase: second.rules.length - 1 } });
  assert.equal(shortPerCase.budget.ruleLimitExceeded, true);
  assert.equal(shortPerCase.budget.actualRuleChecks, 0);
  assert.equal(shortPerCase.gate.passed, false);
});

test('strict case/rule limits and ambiguous predicates cannot create an unsafe proposal', () => {
  assert.equal(RsiCasesSchema.safeParse(Array.from({ length: MAX_RSI_CASES + 1 }, (_, index) => ({ ...DEMO_CASES[0], id: `case.${index}` }))).success, false);
  assert.equal(RsiCasesSchema.safeParse([DEMO_CASES[0], DEMO_CASES[0]]).success, false);
  assert.equal(RsiCasesSchema.safeParse([
    DEMO_CASES[3], { ...DEMO_CASES[3], id: 'copied.holdout', slice: 'holdout' },
  ]).success, false);
  assert.equal(RsiCasesSchema.safeParse([
    DEMO_CASES[3], { ...DEMO_CASES[3], id: 'another.adaptive' },
  ]).success, true);
  assert.equal(RsiRulesSchema.safeParse([
    { id: 'one', predicate: { httpStatus: 401 }, reason: 'auth_denied' },
    { id: 'two', predicate: { httpStatus: 401 }, reason: 'timeout' },
  ]).success, false);
  const contradictory: RsiCase[] = [
    { id: 'one', slice: 'adaptive', input: { errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'operator' },
    { id: 'two', slice: 'adaptive', input: { errorCode: 'ETIMEDOUT' }, expectedReason: 'auth_denied', source: 'operator' },
  ];
  assert.equal(proposeRules(contradictory, []).status, 'conflict');
  const full: RsiRules = Array.from({ length: MAX_RSI_RULES }, (_, index) => ({ id: `rule.${index}`, predicate: { httpStatus: 100 + index }, reason: 'unknown' }));
  assert.equal(proposeRules(adaptive, full).status, 'rule_limit');
  assert.equal(RsiRulesSchema.safeParse([...full, { id: 'extra', predicate: { httpStatus: 200 }, reason: 'unknown' }]).success, false);
  assert.equal(DEMO_CASES.every((item) => item.source === 'synthetic'), true);
});
