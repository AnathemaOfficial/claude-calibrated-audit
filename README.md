# calibrated-audit

A **cost-calibrated, multi-agent code audit** for [Claude Code](https://claude.com/claude-code) — a workflow + slash command that sweeps a repo for security and correctness issues without burning a fortune in tokens.

It fans out one agent per dimension to *find* issues, then **gates the expensive verification by severity**, and keeps the optional "what did we miss?" pass off by default.

---

## Why this exists (the cost lesson)

A naive *"be exhaustive, cost is no constraint"* multi-agent audit of a mid-size web app cost **~15M tokens**. Reading back the agent transcripts showed where the money actually went:

| | |
|---|---|
| Actual generation (output tokens) | **~1.2M** — small |
| Agents that were **verification** | **76%** (140 verifiers vs 39 finders) |
| The rest | reading + cache (cheap) |

The takeaway is counter-intuitive: **the cost is not the repo's complexity — it's the exhaustiveness knob.** Discovery is cheap. **Verification is the dial.** Cranking it to "triple-verify everything + a second completeness wave" is what runs up the bill — usually for the last 10% of confidence.

So this workflow bakes the discipline in instead of leaving it to a model's judgment in the moment.

## The cost levers (all encoded in the workflow)

1. **Scoped finders** — audit only the dimensions you ask for (default: 7 security ones, not all of them).
2. **Severity-gated verification** — the single biggest saver:
   - `CRITICAL` / `HIGH` → **2** adversarial lenses (refute + exploit)
   - `MEDIUM` → **1** lens
   - `LOW` → **0** agents (self-reported, flagged unverified)
3. **Completeness wave OFF by default** — the "what's missing?" critic + follow-up finders is opt-in (`deep: true`) and capped.
4. **Lean prompts** — findings only, no echoing source code back.
5. **Cost summary returned every run** — an agent count so you see the spend.

Estimated **~3–5× cheaper** than an ungated exhaustive run, for ~90% of the value. Run it on a **cost-efficient model** — the sub-agents inherit your session model, and that's where the savings come from.

## What you get back

The workflow returns structured results:

- **confirmed** — findings that survived verification (severity + `file:line` + evidence + impact + suggested fix).
- **contested** — one lens refuted, one held → a genuine borderline worth a human call.
- **refuted** — findings the verification *killed* (false positives), with the reasoning. This is the part that earns the verification cost: external/agentic reviewers do produce false positives, and you want them caught before they reach you.
- **coverage** — what each finder actually read.

---

## Install

Requires **Claude Code** with workflow support.

Drop the two files into your Claude config:

```
~/.claude/workflows/calibrated-audit.js     # the orchestration (the calibration lives here)
~/.claude/commands/audit.md                 # the /audit slash command (a thin wrapper)
```

> The `/audit` command references the workflow by path — open `commands/audit.md` and set the `scriptPath` to wherever you put `calibrated-audit.js`.

## Usage

### Via the `/audit` command

```
/audit                          # audit the current repo, 7 security dimensions, lean
/audit . auth,billing           # only the auth + billing dimensions
/audit ./packages/api auth,api,storage deep   # + the completeness wave (pricier)
/audit . auth l1                # 1 lens = ultra-cheap
/audit . billing l3             # 3 lenses on HIGH+ = paranoid
```

Add your own target shorthands by editing `commands/audit.md` (e.g. map `MYAPP` → an absolute path).

### Or invoke the workflow directly

```js
Workflow({
  scriptPath: "~/.claude/workflows/calibrated-audit.js",
  args: { target: ".", scope: ["auth", "billing"], deep: false, lenses: 2 }
})
```

### Args

| arg | type | default | meaning |
|---|---|---|---|
| `target` | string | `"."` | repo / sub-path to audit |
| `scope` | string[] | 7 security dims | `auth billing tier api connectors agent storage boundary quality drift` |
| `deep` | bool | `false` | enable the completeness critic + follow-up wave |
| `lenses` | number | `2` | verification lenses on HIGH+ (1 cheap → 3 paranoid) |

## Dimensions

`auth` · `billing` · `tier` (quotas/entitlements) · `api` (route surface) · `connectors` (third-party/OAuth) · `agent` (LLM/tool layer) · `storage` (data races/transactions) · `boundary` (HMAC/trust boundaries) · `quality` (type-safety/async) · `drift` (dead code/doc drift).

Each is a focused brief; edit `DIMENSION_LIBRARY` in the workflow to add your own.

## Audit ≠ review

This audits the **whole repo** (a standing sweep, no diff needed). To review **changes** (a diff / branch / PR), use Claude Code's built-in `/code-review` (which has its own effort tiers). Different tool, different job.

## License

MIT — see [LICENSE](LICENSE).
