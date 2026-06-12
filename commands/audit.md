---
description: Cost-calibrated deep audit of a repo (security/correctness sweep by dimension). Runs the calibrated-audit workflow. Args — [target] [scope] [deep|lean] [lensesN]
argument-hint: "[path|shorthand] [dim1,dim2,…] [deep] [lenses2]"
---

You are launching a **cost-calibrated code audit**. This IS the multi-agent opt-in: invoke the `calibrated-audit` workflow via the **Workflow** tool (do NOT improvise the orchestration — the cost calibration lives in the script).

## Parse `$ARGUMENTS`

Raw args: `$ARGUMENTS`

Extract (all optional, any order):
- **target** — first token. Resolve shorthands to paths if you have a project map (see "Customize" below); otherwise treat a path-like token as the path. **Default if absent:** `.` (the current working directory).
- **scope** — a comma-containing token (e.g. `auth,billing,api`). Valid keys: `auth billing tier api connectors agent storage boundary quality drift`. Absent → leave the workflow default (7 security dimensions).
- **deep** — if the word `deep` appears → `deep: true` (enables the completeness wave). Otherwise `deep: false` (lean, the cheaper default).
- **lenses** — a `lensesN` or `lN` token (e.g. `lenses1`, `l3`) → `lenses: N` (1 = ultra-cheap, 2 = default, 3 = paranoid on HIGH+).

## Before launching

1. Confirm in one line what you'll run: target + scope + lean/deep + lenses.
2. If your harness lets you pick a model, prefer a **cost-efficient one** — sub-agents inherit the session model, and that's where the savings come from.

## Launch

Call **Workflow** with the path where you installed the workflow script:
```
Workflow({
  scriptPath: "<your ~/.claude/workflows>/calibrated-audit.js",
  args: { target: <resolved>, scope: <array or omit>, deep: <bool>, lenses: <N or omit> }
})
```

## After

When the workflow returns:
- Read `costNote` and relay it (agent count = the real spend).
- Present **confirmed** findings by severity (CRITICAL → LOW), then **contested** (human call), then one line on **refuted** (false positives the verification killed — proof the verification did its job).
- Write a full dated `.md` report at the working root if the audit is large (>5 findings).
- **Do NOT fix anything without the user's go-ahead.** An audit finds; fixes are a separate decision (prioritize first).

## Customize

Add your own target shorthands by editing this file — e.g. map `MYAPP` → `/abs/path/to/myapp` in the "target" parsing step so you can run `/audit MYAPP auth,billing`.

Doctrine: discovery is cheap; **verification** is the dial. Gate it by severity.
