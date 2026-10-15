import { z } from 'zod';

/** A bounded, deterministic rule learner; this is not evidence of strong recursive self-improvement. */
export const MAX_RSI_RULES = 32;
export const MAX_RSI_CASES = 200;
export const RSI_SLICES = ['frozen', 'adaptive', 'holdout'] as const;
export const RsiSliceSchema = z.enum(RSI_SLICES);
export const RsiReasonSchema = z.enum([
  'timeout', 'rate_limited', 'auth_denied', 'not_found', 'upstream_unavailable',
  'connection_refused', 'invalid_input', 'unknown',
]);
export const RsiErrorCodeSchema = z.enum([
  'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EINVAL', 'AUTH_DENIED',
  'RATE_LIMITED', 'NOT_FOUND', 'UPSTREAM_UNAVAILABLE',
]);
const RsiIdSchema = z.string().min(1).max(96).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const RsiInputSchema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  errorCode: RsiErrorCodeSchema.optional(),
}).strict();
export const RsiPredicateSchema = RsiInputSchema.refine(
  (predicate) => predicate.httpStatus !== undefined || predicate.errorCode !== undefined,
  'A rule must select an HTTP status or a known error code',
);
export const RsiRuleSchema = z.object({
  id: RsiIdSchema,
  predicate: RsiPredicateSchema,
  reason: RsiReasonSchema,
}).strict();
export const RsiCaseSchema = z.object({
  id: RsiIdSchema,
  slice: RsiSliceSchema,
  input: RsiInputSchema,
  expectedReason: RsiReasonSchema,
  source: z.enum(['synthetic', 'operator']),
}).strict();

export type RsiInput = z.infer<typeof RsiInputSchema>;
export type RsiPredicate = z.infer<typeof RsiPredicateSchema>;
export type RsiReason = z.infer<typeof RsiReasonSchema>;
export type RsiSlice = z.infer<typeof RsiSliceSchema>;
export type RsiCase = z.infer<typeof RsiCaseSchema>;
export type RsiRule = z.infer<typeof RsiRuleSchema>;

function predicateKey(predicate: RsiPredicate): string {
  return `${predicate.httpStatus ?? '*'}:${predicate.errorCode ?? '*'}`;
}

export const RsiRulesSchema = z.array(RsiRuleSchema).max(MAX_RSI_RULES).superRefine((rules, ctx) => {
  const ids = new Set<string>();
  const predicates = new Set<string>();
  rules.forEach((rule, index) => {
    if (ids.has(rule.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Rule IDs must be unique' });
    if (predicates.has(predicateKey(rule.predicate))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'predicate'], message: 'Duplicate or conflicting predicates are forbidden' });
    }
    ids.add(rule.id);
    predicates.add(predicateKey(rule.predicate));
  });
});
export type RsiRules = z.infer<typeof RsiRulesSchema>;
export const RsiCasesSchema = z.array(RsiCaseSchema).max(MAX_RSI_CASES).superRefine((cases, ctx) => {
  const ids = new Set<string>();
  const inputSlices = new Map<string, RsiSlice>();
  cases.forEach((item, index) => {
    if (ids.has(item.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Case IDs must be unique' });
    const key = predicateKey(item.input);
    const previousSlice = inputSlices.get(key);
    if (previousSlice !== undefined && previousSlice !== item.slice) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'input'], message: 'Identical inputs may not appear in different evaluation slices' });
    }
    inputSlices.set(key, item.slice);
    ids.add(item.id);
  });
});
export const RsiBudgetSchema = z.object({
  maxRuleChecksPerCase: z.number().int().min(1).max(MAX_RSI_RULES),
  maxTotalRuleChecks: z.number().int().min(1).max(MAX_RSI_RULES * MAX_RSI_CASES * 3),
}).strict();
export type RsiBudget = z.infer<typeof RsiBudgetSchema>;
export const DEFAULT_RSI_BUDGET: Readonly<RsiBudget> = Object.freeze({
  maxRuleChecksPerCase: MAX_RSI_RULES,
  maxTotalRuleChecks: MAX_RSI_RULES * MAX_RSI_CASES * 3,
});

function matches(input: RsiInput, predicate: RsiPredicate): boolean {
  return (predicate.httpStatus === undefined || predicate.httpStatus === input.httpStatus)
    && (predicate.errorCode === undefined || predicate.errorCode === input.errorCode);
}

export interface Classification {
  reason: RsiReason;
  matchedRuleId: string | null;
  ruleChecks: number;
  truncated: boolean;
}

function classifyValidated(input: RsiInput, rules: RsiRules, limit: number): Classification {
  const count = Math.min(rules.length, limit);
  for (let index = 0; index < count; index += 1) {
    if (matches(input, rules[index].predicate)) {
      return { reason: rules[index].reason, matchedRuleId: rules[index].id, ruleChecks: index + 1, truncated: false };
    }
  }
  return { reason: 'unknown', matchedRuleId: null, ruleChecks: count, truncated: rules.length > limit };
}

/** The exact same ordered interpreter is used for active, candidate, and no-retention controls. */
export function classify(input: RsiInput, rules: RsiRules, maxRuleChecksPerCase = MAX_RSI_RULES): Classification {
  const limit = RsiBudgetSchema.shape.maxRuleChecksPerCase.parse(maxRuleChecksPerCase);
  return classifyValidated(RsiInputSchema.parse(input), RsiRulesSchema.parse(rules), limit);
}

export interface RuleProposal {
  status: 'proposed' | 'no_change' | 'conflict' | 'rule_limit';
  rules: RsiRules;
  addedRule: RsiRule | null;
  evidenceCaseIds: string[];
  reason: string;
}

/** This API accepts only adaptive examples; frozen and holdout labels never enter proposal generation. */
export function proposeRules(adaptiveCases: RsiCase[], activeRules: RsiRules): RuleProposal {
  const cases = RsiCasesSchema.parse(adaptiveCases);
  if (cases.some((item) => item.slice !== 'adaptive')) throw new Error('Proposal generation accepts only adaptive cases');
  const rules = RsiRulesSchema.parse(activeRules);
  const incorrect = cases.filter((item) => classifyValidated(item.input, rules, MAX_RSI_RULES).reason !== item.expectedReason);
  if (!incorrect.length) {
    return { status: 'no_change', rules, addedRule: null, evidenceCaseIds: [], reason: 'All adaptive examples are already classified correctly' };
  }
  if (rules.length === MAX_RSI_RULES) {
    return { status: 'rule_limit', rules, addedRule: null, evidenceCaseIds: [], reason: 'The bounded rule package is full' };
  }
  for (const item of incorrect) {
    // Prefer an error category over a status pair so a held-out status can test transfer.
    const predicate: RsiPredicate | null = item.input.errorCode !== undefined
      ? { errorCode: item.input.errorCode }
      : item.input.httpStatus !== undefined ? { httpStatus: item.input.httpStatus } : null;
    if (!predicate || rules.some((rule) => predicateKey(rule.predicate) === predicateKey(predicate))) continue;
    const evidence = cases.filter((example) => matches(example.input, predicate));
    if (evidence.some((example) => example.expectedReason !== item.expectedReason)) continue;
    const stem = `learned.${predicate.errorCode ?? `http${predicate.httpStatus}`}.${item.expectedReason}`;
    let id = stem;
    let suffix = 1;
    while (rules.some((rule) => rule.id === id)) id = `${stem}.${suffix++}`;
    const addedRule: RsiRule = { id, predicate, reason: item.expectedReason };
    return {
      status: 'proposed', rules: RsiRulesSchema.parse([addedRule, ...rules]), addedRule,
      evidenceCaseIds: evidence.map((example) => example.id),
      reason: 'One general predicate learned from adaptive errors; every parent rule is retained',
    };
  }
  return {
    status: 'conflict', rules, addedRule: null, evidenceCaseIds: incorrect.map((item) => item.id),
    reason: 'No unambiguous new predicate can be inferred from adaptive errors',
  };
}

export interface ReplayCaseResult extends Classification {
  caseId: string;
  slice: RsiSlice;
  expectedReason: RsiReason;
  correct: boolean;
}
export interface ReplaySliceMetrics {
  total: number;
  correct: number;
  accuracy: number | null;
  ruleChecks: number;
}
export interface ReplayScenario {
  evaluated: boolean;
  ruleCount: number;
  caseCount: number;
  correct: number;
  accuracy: number | null;
  ruleChecks: number;
  slices: Record<RsiSlice, ReplaySliceMetrics>;
  results: ReplayCaseResult[];
}
export interface ReplayComparison {
  improvedCaseIds: string[];
  regressedCaseIds: string[];
  accuracyDelta: number | null;
}
export interface ReplayReport {
  scenarios: { active: ReplayScenario; candidate: ReplayScenario; noRetention: ReplayScenario };
  comparisons: { activeToCandidate: Record<RsiSlice, ReplayComparison> };
  /** Positive deltas measure retention against the supplied independently reset control. */
  retention: Record<RsiSlice, ReplayComparison>;
  budget: {
    maxRuleChecksPerCase: number;
    allocatedRuleChecks: number;
    reservedRuleChecks: number;
    actualRuleChecks: number;
    withinBudget: boolean;
    equalPerCaseLimit: true;
    ruleLimitExceeded: boolean;
  };
  gate: { passed: boolean; reasons: string[] };
  evidenceKind: 'bounded_deterministic_rule_replay';
}

function evaluateScenario(cases: RsiCase[], rules: RsiRules, limit: number): ReplayScenario {
  const slices: Record<RsiSlice, ReplaySliceMetrics> = {
    frozen: { total: 0, correct: 0, accuracy: null, ruleChecks: 0 },
    adaptive: { total: 0, correct: 0, accuracy: null, ruleChecks: 0 },
    holdout: { total: 0, correct: 0, accuracy: null, ruleChecks: 0 },
  };
  const results = cases.map((item): ReplayCaseResult => {
    const result = classifyValidated(item.input, rules, limit);
    const correct = result.reason === item.expectedReason;
    const slice = slices[item.slice];
    slice.total += 1;
    slice.correct += Number(correct);
    slice.ruleChecks += result.ruleChecks;
    return { ...result, caseId: item.id, slice: item.slice, expectedReason: item.expectedReason, correct };
  });
  for (const slice of RSI_SLICES) slices[slice].accuracy = slices[slice].total ? slices[slice].correct / slices[slice].total : null;
  const correct = results.filter((result) => result.correct).length;
  return {
    evaluated: true, ruleCount: rules.length, caseCount: cases.length, correct,
    accuracy: cases.length ? correct / cases.length : null,
    ruleChecks: results.reduce((sum, result) => sum + result.ruleChecks, 0), slices, results,
  };
}

function skippedScenario(cases: RsiCase[], rules: RsiRules): ReplayScenario {
  const slices = Object.fromEntries(RSI_SLICES.map((slice) => [slice, {
    total: cases.filter((item) => item.slice === slice).length,
    correct: 0, accuracy: null, ruleChecks: 0,
  }])) as Record<RsiSlice, ReplaySliceMetrics>;
  return { evaluated: false, ruleCount: rules.length, caseCount: cases.length, correct: 0, accuracy: null, ruleChecks: 0, slices, results: [] };
}

function compareScenarios(before: ReplayScenario, after: ReplayScenario): Record<RsiSlice, ReplayComparison> {
  const comparison: Record<RsiSlice, ReplayComparison> = {
    frozen: { improvedCaseIds: [], regressedCaseIds: [], accuracyDelta: null },
    adaptive: { improvedCaseIds: [], regressedCaseIds: [], accuracyDelta: null },
    holdout: { improvedCaseIds: [], regressedCaseIds: [], accuracyDelta: null },
  };
  after.results.forEach((result, index) => {
    const previous = before.results[index];
    if (!previous.correct && result.correct) comparison[result.slice].improvedCaseIds.push(result.caseId);
    if (previous.correct && !result.correct) comparison[result.slice].regressedCaseIds.push(result.caseId);
  });
  for (const slice of RSI_SLICES) {
    const previous = before.slices[slice].accuracy;
    const next = after.slices[slice].accuracy;
    comparison[slice].accuracyDelta = previous === null || next === null ? null : next - previous;
  }
  return comparison;
}

/** Replays all three variants on one parsed case set with one interpreter and one budget. */
export function runReplay(input: {
  cases: RsiCase[];
  activeRules: RsiRules;
  candidateRules: RsiRules;
  noRetentionRules: RsiRules;
  budget: RsiBudget;
}): ReplayReport {
  const cases = RsiCasesSchema.parse(input.cases);
  const activeRules = RsiRulesSchema.parse(input.activeRules);
  const candidateRules = RsiRulesSchema.parse(input.candidateRules);
  const noRetentionRules = RsiRulesSchema.parse(input.noRetentionRules);
  const budget = RsiBudgetSchema.parse(input.budget);
  const limit = budget.maxRuleChecksPerCase;
  // Reserve the same worst-case allowance for each variant before considering results.
  const reservedRuleChecks = cases.length * limit * 3;
  const ruleLimitExceeded = [activeRules, candidateRules, noRetentionRules].some((rules) => rules.length > limit);
  const withinBudget = reservedRuleChecks <= budget.maxTotalRuleChecks && !ruleLimitExceeded;
  const reasons: string[] = [];
  if (!withinBudget) reasons.push('comparison_budget_exceeded');
  const scenarios = {
    active: withinBudget ? evaluateScenario(cases, activeRules, limit) : skippedScenario(cases, activeRules),
    candidate: withinBudget ? evaluateScenario(cases, candidateRules, limit) : skippedScenario(cases, candidateRules),
    noRetention: withinBudget ? evaluateScenario(cases, noRetentionRules, limit) : skippedScenario(cases, noRetentionRules),
  };
  const activeToCandidate = compareScenarios(scenarios.active, scenarios.candidate);
  for (const slice of RSI_SLICES) if (!scenarios.active.slices[slice].total) reasons.push(`missing_${slice}_cases`);
  if (activeToCandidate.frozen.regressedCaseIds.length) reasons.push('frozen_regression');
  if (activeToCandidate.adaptive.regressedCaseIds.length) reasons.push('adaptive_regression');
  if ((activeToCandidate.adaptive.accuracyDelta ?? 0) <= 0) reasons.push('adaptive_improvement_required');
  if (activeToCandidate.holdout.regressedCaseIds.length) reasons.push('holdout_regression');
  if ((activeToCandidate.holdout.accuracyDelta ?? 0) <= 0) reasons.push('holdout_transfer_required');
  return {
    scenarios, comparisons: { activeToCandidate },
    retention: compareScenarios(scenarios.noRetention, scenarios.candidate),
    budget: {
      maxRuleChecksPerCase: limit, allocatedRuleChecks: budget.maxTotalRuleChecks, reservedRuleChecks,
      actualRuleChecks: scenarios.active.ruleChecks + scenarios.candidate.ruleChecks + scenarios.noRetention.ruleChecks,
      withinBudget, equalPerCaseLimit: true, ruleLimitExceeded,
    },
    gate: { passed: reasons.length === 0, reasons }, evidenceKind: 'bounded_deterministic_rule_replay',
  };
}

const RsiAccuracySchema = z.number().min(0).max(1).nullable();
const RsiCountSchema = z.number().int().min(0).max(MAX_RSI_CASES);
const RsiSliceMetricsSchema = z.object({
  total: RsiCountSchema, correct: RsiCountSchema, accuracy: RsiAccuracySchema,
  ruleChecks: z.number().int().min(0).max(MAX_RSI_CASES * MAX_RSI_RULES),
}).strict();
const RsiClassificationSchema = z.object({
  reason: RsiReasonSchema, matchedRuleId: RsiIdSchema.nullable(),
  ruleChecks: z.number().int().min(0).max(MAX_RSI_RULES), truncated: z.boolean(),
}).strict();
const RsiScenarioSchema = z.object({
  evaluated: z.boolean(), ruleCount: z.number().int().min(0).max(MAX_RSI_RULES),
  caseCount: RsiCountSchema, correct: RsiCountSchema, accuracy: RsiAccuracySchema,
  ruleChecks: z.number().int().min(0).max(MAX_RSI_CASES * MAX_RSI_RULES),
  slices: z.object({ frozen: RsiSliceMetricsSchema, adaptive: RsiSliceMetricsSchema, holdout: RsiSliceMetricsSchema }).strict(),
  results: z.array(RsiClassificationSchema.extend({
    caseId: RsiIdSchema, slice: RsiSliceSchema, expectedReason: RsiReasonSchema, correct: z.boolean(),
  }).strict()).max(MAX_RSI_CASES),
}).strict();
const RsiComparisonSchema = z.object({
  improvedCaseIds: z.array(RsiIdSchema).max(MAX_RSI_CASES),
  regressedCaseIds: z.array(RsiIdSchema).max(MAX_RSI_CASES),
  accuracyDelta: z.number().min(-1).max(1).nullable(),
}).strict();
const RsiComparisonSlicesSchema = z.object({
  frozen: RsiComparisonSchema, adaptive: RsiComparisonSchema, holdout: RsiComparisonSchema,
}).strict();

/** Exact storage shape; acceptance must additionally recompute this deterministic report. */
export const ReplayReportSchema = z.object({
  scenarios: z.object({ active: RsiScenarioSchema, candidate: RsiScenarioSchema, noRetention: RsiScenarioSchema }).strict(),
  comparisons: z.object({ activeToCandidate: RsiComparisonSlicesSchema }).strict(),
  retention: RsiComparisonSlicesSchema,
  budget: z.object({
    maxRuleChecksPerCase: RsiBudgetSchema.shape.maxRuleChecksPerCase,
    allocatedRuleChecks: RsiBudgetSchema.shape.maxTotalRuleChecks,
    reservedRuleChecks: z.number().int().min(0).max(MAX_RSI_RULES * MAX_RSI_CASES * 3),
    actualRuleChecks: z.number().int().min(0).max(MAX_RSI_RULES * MAX_RSI_CASES * 3),
    withinBudget: z.boolean(), equalPerCaseLimit: z.literal(true), ruleLimitExceeded: z.boolean(),
  }).strict(),
  gate: z.object({
    passed: z.boolean(), reasons: z.array(z.enum([
      'comparison_budget_exceeded', 'missing_frozen_cases', 'missing_adaptive_cases', 'missing_holdout_cases',
      'frozen_regression', 'adaptive_regression', 'adaptive_improvement_required', 'holdout_regression', 'holdout_transfer_required',
    ])).max(9),
  }).strict(),
  evidenceKind: z.literal('bounded_deterministic_rule_replay'),
}).strict();

/** These examples are explicitly synthetic and never represent observed production incidents. */
export const BASELINE_RULES: RsiRules = [
  { id: 'baseline.auth', predicate: { httpStatus: 401 }, reason: 'auth_denied' },
  { id: 'baseline.missing', predicate: { httpStatus: 404 }, reason: 'not_found' },
  { id: 'baseline.input', predicate: { httpStatus: 400 }, reason: 'invalid_input' },
];
export const DEMO_CASES: RsiCase[] = [
  { id: 'frozen.auth', slice: 'frozen', input: { httpStatus: 401 }, expectedReason: 'auth_denied', source: 'synthetic' },
  { id: 'frozen.missing', slice: 'frozen', input: { httpStatus: 404 }, expectedReason: 'not_found', source: 'synthetic' },
  { id: 'frozen.input', slice: 'frozen', input: { httpStatus: 400 }, expectedReason: 'invalid_input', source: 'synthetic' },
  { id: 'adaptive.timeout', slice: 'adaptive', input: { httpStatus: 504, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'synthetic' },
  { id: 'adaptive.rate', slice: 'adaptive', input: { httpStatus: 429, errorCode: 'RATE_LIMITED' }, expectedReason: 'rate_limited', source: 'synthetic' },
  { id: 'holdout.timeout', slice: 'holdout', input: { httpStatus: 408, errorCode: 'ETIMEDOUT' }, expectedReason: 'timeout', source: 'synthetic' },
  { id: 'holdout.rate', slice: 'holdout', input: { httpStatus: 503, errorCode: 'RATE_LIMITED' }, expectedReason: 'rate_limited', source: 'synthetic' },
];
