#!/usr/bin/env node
/** Run with node --import tsx tools/rsi-learning-demo.mjs. No external calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RsiLedgerService } from '../server/evolution/rsi-ledger.ts';
import { classify } from '../server/evolution/rsi-replay.ts';

const args = process.argv.slice(2);
const allowed = new Set(['--state-dir', '--output']);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!allowed.has(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Usage: node --import tsx tools/rsi-learning-demo.mjs [--state-dir DIR] [--output FILE]');
  options[args[i]] = args[i+1];
}
const stateDir = options['--state-dir'] ? resolve(options['--state-dir']) : await mkdtemp(join(tmpdir(), 'd-obs-rsi-demo-'));
const service = new RsiLedgerService({ stateDir });
const owner = 'synthetic-demo-operator';
let loop = await service.seedDemo(owner);
const rounds = [];
for (let round = 1; round <= 2; round++) {
  const loadedVersionId = loop.activeVersionId;
  loop = await service.propose(owner, loop.id, { expectedRevision: loop.revision });
  const candidate = loop.versions.find(version => version.id === loop.candidateVersionId);
  assert.equal(candidate.loadedVersionId, loadedVersionId);
  loop = await service.replay(owner, loop.id, { expectedRevision: loop.revision });
  const replay = loop.replays.at(-1);
  assert.equal(replay.report.gate.passed, true);
  loop = await service.accept(owner, loop.id, { expectedRevision: loop.revision });
  rounds.push({ round, loadedVersionId, acceptedVersionId: loop.activeVersionId, caseSetHash: loop.casesHash, replayId: replay.id, report: replay.report });
}
const reopened = await new RsiLedgerService({ stateDir }).getLoop(owner, loop.id);
assert.equal(reopened.activeVersionId, rounds.at(-1).acceptedVersionId);
const rules = reopened.versions.find(version => version.id === reopened.activeVersionId).rules;
assert.equal(classify({ errorCode: 'ETIMEDOUT' }, rules).reason, 'timeout');
assert.equal(classify({ errorCode: 'RATE_LIMITED' }, rules).reason, 'rate_limited');
const result = {
  source: 'synthetic', evidenceKind: 'bounded_deterministic_rule_replay',
  generatedAt: new Date().toISOString(), stateDir, owner, loopId: loop.id,
  rounds, reloadedActiveVersionId: reopened.activeVersionId,
  explanation: 'Two inherited PFO cycles; each control repeats one proposal from the original rules under the same replay budget. These are synthetic fixtures, not production quality measurements.',
};
if (options['--output']) {
  const output = resolve(options['--output']);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2)+'\n', { mode: 0o600 });
}
console.log(JSON.stringify({source:result.source,loopId:result.loopId,stateDir:result.stateDir,rounds:rounds.map(r=>({round:r.round,loadedVersionId:r.loadedVersionId,acceptedVersionId:r.acceptedVersionId,frozen:r.report.scenarios.candidate.slices.frozen.accuracy,adaptive:r.report.scenarios.candidate.slices.adaptive.accuracy,holdout:r.report.scenarios.candidate.slices.holdout.accuracy,noRetentionHoldout:r.report.scenarios.noRetention.slices.holdout.accuracy,gatePassed:r.report.gate.passed})),reloadedActiveVersionId:result.reloadedActiveVersionId},null,2));
