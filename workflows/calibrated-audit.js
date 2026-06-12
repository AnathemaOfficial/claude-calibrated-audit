export const meta = {
  name: 'calibrated-audit',
  description: 'Cost-calibrated code audit: scoped finders + severity-GATED adversarial verification + OPTIONAL completeness wave. Built to run lean. Args: { target?, scope?, deep?, lenses? }',
  phases: [
    { title: 'Find', detail: 'finders over the scoped dimensions' },
    { title: 'Verify', detail: 'gated: HIGH+ = 2 lenses, MEDIUM = 1, LOW = 0' },
    { title: 'Complete', detail: 'completeness critic — ONLY when deep=true' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — the cost lesson.
// A naive "be exhaustive" multi-agent audit of a mid-size web app cost ~15M
// tokens. Breaking down the transcripts showed where it went:
//   • Actual generation (output) was only ~1.2M tokens.
//   • 76% of the AGENTS were VERIFICATION (140 verifiers vs 39 finders).
//   • The rest was reading/cache (cheap).
// Conclusion: the cost is NOT the repo's complexity — it's the EXHAUSTIVENESS
// knob (dimensions × verification lenses × completeness waves). DISCOVERY is
// cheap; VERIFICATION is the dial. This workflow bakes that discipline in.
//
// COST LEVERS (all encoded below, so the orchestration can't over-spend):
//   1. SCOPE       : audit ONLY the requested dimensions (default 7 security
//                    ones, not all of them). args.scope = ['auth','billing',…].
//   2. GATED VERIFY: CRITICAL/HIGH → 2 lenses, MEDIUM → 1, LOW → 0 (self-
//                    reported). This is the single biggest saver.
//   3. COMPLETE OFF: the completeness critic + follow-up wave is OFF by default
//                    (args.deep=true to enable; it stays capped at 3 gaps).
//   4. LEAN PROMPTS: findings-only, no echoing source code back.
//   5. COST SUMMARY: returns an agent count so you see the spend each run.
// Run it on a cost-efficient model — the sub-agents inherit the session model.
// ─────────────────────────────────────────────────────────────────────────────

const TARGET = (args && args.target) || '.'
const DEEP = !!(args && args.deep)
// args.lenses forces 1 (ultra-cheap) or 3 (paranoid) on HIGH+; default 2.
const HIGH_LENSES = (args && Number(args.lenses)) || 2

const DIMENSION_LIBRARY = {
  auth: `AUTH & SESSIONS: routes trusting client-supplied headers/ids outside strict dev-only gating, ungated legacy twin routes, request-context resolution (auto-create, fallbacks, cookie parsing), session creation/validation/expiry, password reset (OTP brute-force, token scoping), OAuth callbacks (state/CSRF, redirect allowlist).`,
  billing: `BILLING: webhooks (idempotency/replay, signature verification), live-mode quarantine, fail-closed on unknown price but never block a revoke, stale-subscription clobber, phantom-workspace checkout, webhook/checkout races, anti-double-subscription guard, lookup-key collisions.`,
  tier: `TIERS & QUOTAS: real per-tier enforcement (feature gates, LLM/usage quotas, rate of paid actions) — can a free tier reach a paid capability via a forgotten path? authority-flip fail-closed, grace-period expiry, tier-mapping consistency.`,
  api: `API SURFACE: sweep the routes — authz (session + resource ownership), input validation, rate limiting, info leaks in error responses, SSRF (URL-import features), uploads (size/content-type/path-traversal), routes WITHOUT auth (intended vs hole).`,
  connectors: `THIRD-PARTY CONNECTORS: OAuth token storage (encrypted?), refresh, scopes, validation of external responses, silent failures (marking an action done when it isn't), hardcoded secrets, bypasses of the connector abstraction (direct imports).`,
  agent: `AGENT/LLM LAYER: prompt injection (user/web content → unintended tool calls), gating tools by tier/quota BEFORE execution, unbounded cost (LLM loops, retries), timeouts, validating LLM output before acting on it, secret/PII leakage into prompts.`,
  storage: `STORAGE & DATA: read-modify-write races (lost updates on collections), multi-step writes without a transaction (partial states), missing indexes on hot paths, sensitive data stored in clear, startup guards (prod ⇒ durable store), serverless connection pooling.`,
  boundary: `TRUST BOUNDARIES: inter-service signing/HMAC (timing-safe compare, replay protection via nonce/timestamp), default/fallback secret reaching production, secret provenance, unsafe parsing, panics on network paths.`,
  quality: `TYPE SAFETY & ASYNC (production paths, not tests): dangerous any/unknown casts, floating promises, unhandled rejections, swallowed/empty catches on critical paths, JSON.parse without try, parseInt without validation, dodgy date/timezone comparisons.`,
  drift: `DEAD CODE & DRIFT: exposed dead code, legacy twins meant to be removed, docs/README that lie vs the code, TODO/FIXME hiding real bugs, orphaned/unpushed branches or files, git hygiene.`,
}

const DEFAULT_SCOPE = ['auth', 'billing', 'tier', 'api', 'agent', 'storage', 'boundary']
const scopeKeys = (args && Array.isArray(args.scope) && args.scope.length ? args.scope : DEFAULT_SCOPE)
  .filter((k) => DIMENSION_LIBRARY[k])

const RULES = `READ-ONLY STRICT on ${TARGET}: modify NO files (no Write/Edit), no installs, no mutating git. Read with Read/Grep/Glob; Bash for reads only.
Report REAL problems verified by reading the code: cite file + line + the real snippet. No style nitpicks. Max 10 findings/dimension, worst first. If the dimension is clean, findings=[] and say what you checked in notes.
FORBIDDEN: pasting source code into your answer (just file:line + a 1-2 line snippet). Be concise.
Severities: CRITICAL (exploit / data loss / forgeable auth-billing), HIGH (real prod-impacting bug), MEDIUM (real edge case or risky debt), LOW (quality/cleanup).`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    dimension: { type: 'string' },
    coverage: { type: 'string', description: 'What was actually read (dirs, #files)' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'evidence', 'impact'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['dimension', 'coverage', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    severitySuggestion: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNCHANGED'] },
  },
  required: ['refuted', 'reasoning'],
}

function verifyPrompt(fd, lens) {
  const lensTxt = {
    refute: `CORRECTNESS LENS: try to REFUTE this finding by reading the cited real code + its callers. If it does not reproduce, refuted=true. When in doubt, refuted=true (anti-false-positive doctrine).`,
    exploit: `IMPACT LENS: assess real exploitability (preconditions, required auth, dev-only vs prod, data/money at risk). If the real impact is negligible/theoretical, refuted=true. Suggest severitySuggestion, else UNCHANGED.`,
  }[lens]
  return `${RULES}

FINDING TO VERIFY (id ${fd.id}, severity ${fd.severity}):
Title: ${fd.title}
File: ${fd.file}${fd.line ? ' — line ' + fd.line : ''}
Evidence: ${fd.evidence}
Alleged impact: ${fd.impact}

${lensTxt}
Read the REAL code before deciding.`
}

// ── Find: scoped finders, in parallel ─────────────────────────────────────────
phase('Find')
log(`Calibrated audit of ${TARGET} — ${scopeKeys.length} dimension(s): ${scopeKeys.join(', ')}${DEEP ? ' · deep=ON' : ' · lean (deep=OFF)'}`)

const finderResults = (await parallel(
  scopeKeys.map((k) => () =>
    agent(`${RULES}\n\nASSIGNED DIMENSION: ${k}\n${DIMENSION_LIBRARY[k]}\n\nReturn dimension="${k}".`, {
      label: `find:${k}`,
      phase: 'Find',
      schema: FINDINGS_SCHEMA,
    }),
  ),
)).filter(Boolean)

const raw = []
finderResults.forEach((r) => (r.findings || []).forEach((fd, i) => raw.push({ ...fd, dimension: r.dimension, id: `${r.dimension}-${i + 1}` })))
log(`${raw.length} raw findings across ${finderResults.length}/${scopeKeys.length} dimensions`)

// ── Verify: SEVERITY-GATED (the big cost lever) ───────────────────────────────
phase('Verify')
const toVerify = raw.filter((f) => f.severity !== 'LOW') // LOW = 0 agents (self-reported)
const lowFindings = raw
  .filter((f) => f.severity === 'LOW')
  .map((f) => ({ ...f, status: 'unverified-low' }))

const verified = (await parallel(
  toVerify.map((fd) => () => {
    const lenses = fd.severity === 'CRITICAL' || fd.severity === 'HIGH'
      ? ['refute', 'exploit'].slice(0, Math.max(1, Math.min(3, HIGH_LENSES)))
      : ['refute'] // MEDIUM = 1 lens
    return parallel(lenses.map((lens) => () => agent(verifyPrompt(fd, lens), { label: `verify:${fd.id}:${lens}`, phase: 'Verify', schema: VERDICT_SCHEMA })))
      .then((vs) => {
        const votes = vs.filter(Boolean)
        const refutes = votes.filter((v) => v.refuted).length
        const status = votes.length === 0
          ? 'unverified'
          : refutes === 0
            ? 'confirmed'
            : refutes >= votes.length || refutes > votes.length / 2
              ? 'refuted'
              : 'contested'
        return {
          ...fd,
          status,
          voteSummary: votes.map((v) => (v.refuted ? 'REFUTE: ' : 'HOLDS: ') + (v.reasoning || '').slice(0, 240)),
        }
      })
  }),
)).filter(Boolean)

const confirmed = verified.filter((f) => f.status === 'confirmed' || f.status === 'unverified').concat(lowFindings)
const contested = verified.filter((f) => f.status === 'contested')
const refuted = verified.filter((f) => f.status === 'refuted')
log(`${confirmed.filter((f) => f.status !== 'unverified-low').length} confirmed · ${contested.length} contested · ${refuted.length} refuted · ${lowFindings.length} LOW unverified`)

// ── Complete: OPTIONAL (off by default — this was the expensive part) ──────────
let gaps = []
if (DEEP) {
  phase('Complete')
  const critic = await agent(`${RULES}

An audit just ran on ${TARGET}. Dimensions covered: ${finderResults.map((r) => r.dimension).join(', ')}.
Confirmed findings: ${confirmed.map((f) => `[${f.severity}] ${f.title}`).join(' · ') || 'none'}.

What is MISSING? Uncovered subsystems, untested angles, claims asserted but never verified. MAX 3 gaps, each with a self-contained prompt for a finder (absolute paths). If coverage is good, gaps=[].`, {
    label: 'completeness-critic',
    phase: 'Complete',
    schema: { type: 'object', properties: { gaps: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' } }, required: ['title', 'prompt'] } }, assessment: { type: 'string' } }, required: ['gaps'] },
  })
  if (critic && Array.isArray(critic.gaps) && critic.gaps.length) {
    log(`Critic: ${critic.gaps.length} gap(s) → follow-up wave (capped at 3)`)
    const fu = (await parallel(critic.gaps.slice(0, 3).map((g, gi) => () =>
      agent(`${RULES}\n\nDIMENSION: gap-${gi + 1} — ${g.title}\n${g.prompt}\n\nReturn dimension="gap-${gi + 1}".`, { label: `gap:${(g.title || '').slice(0, 28)}`, phase: 'Complete', schema: FINDINGS_SCHEMA }),
    ))).filter(Boolean)
    // gaps verified with a single lens only (lean)
    const fuRaw = []
    fu.forEach((r) => (r.findings || []).forEach((fd, i) => fuRaw.push({ ...fd, dimension: r.dimension, id: `${r.dimension}-${i + 1}` })))
    gaps = (await parallel(fuRaw.filter((f) => f.severity !== 'LOW').map((fd) => () =>
      agent(verifyPrompt(fd, 'refute'), { label: `verify:${fd.id}`, phase: 'Complete', schema: VERDICT_SCHEMA })
        .then((v) => ({ ...fd, status: v && !v.refuted ? 'confirmed' : 'refuted' })),
    ))).filter(Boolean).filter((f) => f.status === 'confirmed')
    log(`Follow-up wave: +${gaps.length} confirmed`)
  }
}

// ── Cost summary (so you see the spend each run) ──────────────────────────────
const agentCount = finderResults.length +
  toVerify.reduce((n, f) => n + (f.severity === 'CRITICAL' || f.severity === 'HIGH' ? HIGH_LENSES : 1), 0) +
  (DEEP ? 1 + gaps.length : 0)

return {
  target: TARGET,
  mode: DEEP ? 'deep' : 'lean',
  scope: scopeKeys,
  costNote: `~${agentCount} agents (finders ${finderResults.length} + gated verification + ${DEEP ? 'completeness ON' : 'completeness OFF'}). Run on a cost-efficient model for the cheap rate.`,
  confirmed: confirmed.concat(gaps),
  contested, // 1 lens refuted, 1 held — worth a human call
  refuted: refuted.map((f) => ({ id: f.id, severity: f.severity, title: f.title, why: f.voteSummary })),
  coverage: finderResults.map((r) => ({ dimension: r.dimension, coverage: r.coverage, notes: r.notes })),
}
