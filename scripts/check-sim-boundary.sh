#!/usr/bin/env bash
# scripts/check-sim-boundary.sh
# FNDN-07 grep backstop — catches nested WorldState sim-state writes that the ESLint
# nonSimMutationGuard tripwire misses (e.g., world.ants.alive[id] = 0).
#
# Run via: bash scripts/check-sim-boundary.sh   (or npm run verify)
# Exits 0 if clean; exits 1 with a reviewer-friendly diagnostic if violations are found.
#
# SCEN-05 magic-number spot check (for reference — not automated here):
#   grep -rnE '\b[0-9]{2,}\b' src/sim/ src/platform/ --include='*.ts'
#   Run manually at phase gate to verify no unnamed integer literals >= 10 remain.
#   ESLint's simSafetyConfig + reviewer grep together satisfy SCEN-05 for Phase 5.
#
# NOTE ON PATTERN: The original RESEARCH.md pattern uses \b word-boundary and (?!=)
# negative-lookahead which require GNU grep (Linux). This script uses BSD-compatible
# ERE syntax: (^|[^[:alnum:]_]) for word-break.
#
# Early iterations used a broad "world.field .* =[^=]" shape that matched any later
# "=" on the line — including the trailing "=" inside "!==", ">=", "<=", "==", "=>".
# So pure-read lines like `if (world.tick !== 0)` and `world.foodPiles.map((p) => ...)`
# tripped the guard and turned the verify gate red. This tightening requires the
# assignment operator to sit immediately after the dotted/indexed field path
# (optionally separated by whitespace). Any intervening operator or paren breaks
# the match, which rules out the previous false-positive shapes while still
# catching every write shape FNDN-07 cares about.

set -euo pipefail

# Anchor: word-break then root ("world" | "worldState" | "w") then one or more
# field-access segments. A segment is ".field" with optional "[...index...]".
# After the final segment, an optional whitespace run, then an assignment or
# UpdateExpression operator. The operator must NOT be part of "==", "!==",
# ">=", "<=", "=>", "!=" — we enforce that with "=[^=>]" (no trailing "=" or
# ">") and by requiring the field path to immediately precede the operator.
#
# Catches:   world.tick = 0 | worldState.rngState += 5 | world.tick++
#            --world.nextEntityId | world.ants.alive[id] = 0
# Rejects:   world.tick !== 0 | world.foodPiles.map((p) => ...)
#            tileX >= world.surface.width | if (world.x === 0)
PATTERN='(^|[^[:alnum:]_])(world|worldState|w)(\.[a-zA-Z_][a-zA-Z0-9_]*(\[[^]]*\])?)+[[:space:]]*(=[^=>]|\+\+|--|\+=|-=|\*=|/=)'

# UpdateExpression prefix form: ++world.tick / --world.nextEntityId.
# Not reachable by the main pattern because it requires the operator AFTER the
# field path, so we match it separately.
PREFIX_PATTERN='(\+\+|--)(world|worldState|w)(\.[a-zA-Z_][a-zA-Z0-9_]*(\[[^]]*\])?)+'

HITS=$( { \
  grep -rnE "$PATTERN"        src/render src/input src/platform --include='*.ts' --exclude='*.test.ts' || true; \
  grep -rnE "$PREFIX_PATTERN" src/render src/input src/platform --include='*.ts' --exclude='*.test.ts' || true; \
  } | grep -v '\.commandQueue' | grep -vE ':[[:space:]]*//' | sort -u || true)

if [[ -n "$HITS" ]]; then
  echo "FNDN-07 violation candidates (review each):"
  echo "$HITS"
  echo ""
  echo "Any actual write to a non-commandQueue WorldState field must be replaced"
  echo "with a SimCommand push per PRD §5."
  exit 1
fi
echo "FNDN-07 grep guard: clean."

# Issue #211 — sim-module-state disable-reason guard.
# A `// eslint-disable[-next]-line subterrans/sim-module-state` MUST carry a
# `-- sim-scratch:/sim-cache:/sim-memo:` reason. A bare disable still "uses" the
# directive (it suppresses the rule), so ESLint won't flag it as unused — but it
# bypasses the reviewable acknowledgement the rule exists to force. Catch bare
# disables here (a line that names the rule in a disable directive but has no
# sim-scratch/sim-cache/sim-memo marker).
DISABLE_HITS=$(grep -rnE 'eslint-disable(-next-line|-line)?[[:space:]]+subterrans/sim-module-state' src/sim --include='*.ts' | grep -vE 'sim-(scratch|cache|memo):' || true)
if [[ -n "$DISABLE_HITS" ]]; then
  echo "subterrans/sim-module-state disable WITHOUT a reason (issue #211):"
  echo "$DISABLE_HITS"
  echo ""
  echo "Every such disable must explain why the module-level state is safe, e.g.:"
  echo "  // eslint-disable-next-line subterrans/sim-module-state -- sim-scratch: reset-per-tick"
  exit 1
fi
echo "sim-module-state disable-reason guard: clean."
