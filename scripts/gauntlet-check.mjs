#!/usr/bin/env node
/**
 * Parity entrypoint: lets the Alfred harness ask Ultron's engine what it thinks.
 *
 * The two runtimes must agree, because a spec that is safe on one engine and
 * unsafe on the other is worse than having only one engine. Alfred's
 * scripts/test_ultron_parity.py drives this and fails the build on divergence.
 *
 *   node scripts/gauntlet-check.mjs validate <spec.json>
 *   node scripts/gauntlet-check.mjs route     <case.json>
 *
 * Both print a single JSON object on stdout and exit 0; a usage error exits 2.
 */
import { promises as fs } from 'node:fs';
import {
  validateGauntlet, route, AttemptLedger,
  MAX_SAME_REASON_RETRIES, MAX_SAME_REASON_REROUTES, MAX_SAME_REASON_ESCALATIONS,
  MAX_GATE_REJECTIONS,
} from '../src/gauntlet.mjs';

const [command, target] = process.argv.slice(2);

const fail = message => { console.error(message); process.exit(2); };

if (!command || !target) fail('usage: gauntlet-check.mjs validate|route <file.json>');

const payload = JSON.parse(await fs.readFile(target, 'utf8'));

if (command === 'validate') {
  const errors = validateGauntlet(payload);
  console.log(JSON.stringify({ engine: 'ultron', valid: errors.length === 0, count: errors.length, errors }, null, 2));
} else if (command === 'route') {
  // A route case: { verdict, node, retries, reroutes, escalations, noProgress }
  const ledger = new AttemptLedger();
  const name = payload.node?.name ?? '<unnamed>';
  const code = payload.verdict?.reasons?.[0]?.code ?? null;
  for (let i = 0; i < (payload.retries || 0); i++) ledger.record(name, payload.verdict);
  // Distinct-code rejections: exercise the code-independent backstop.
  for (let i = 0; i < (payload.rejections || 0); i++) {
    ledger.record(name, { verdict: 'RETRY', reasons: [{ code: `NOVEL_${i}` }] });
  }
  for (let i = 0; i < (payload.reroutes || 0); i++) ledger.recordReroute(name, code);
  for (let i = 0; i < (payload.escalations || 0); i++) ledger.recordEscalation(name, code);
  const decision = route(payload.verdict, payload.node, ledger, { noProgress: !!payload.noProgress });
  console.log(JSON.stringify({
    engine: 'ultron',
    action: decision.action, target: decision.target ?? null,
    verdict: decision.verdict, forced: decision.forced,
    bounds: {
      retries: MAX_SAME_REASON_RETRIES,
      reroutes: MAX_SAME_REASON_REROUTES,
      escalations: MAX_SAME_REASON_ESCALATIONS,
      rejections: MAX_GATE_REJECTIONS,
    },
  }, null, 2));
} else {
  fail(`unknown command '${command}'`);
}
