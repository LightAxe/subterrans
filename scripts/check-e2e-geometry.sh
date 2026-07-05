#!/usr/bin/env bash
# scripts/check-e2e-geometry.sh
# #240 — keep canvas-click geometry OUT of the Playwright specs. Specs run in Node
# and can't import ui-scene.ts (Phaser touches `window` at load), so coordinates
# used to be hand-duplicated and rotted suite-wide (#186). They now come from
# tests/helpers/geometry.ts (which evaluates the pure, Phaser-free layout modules).
#
# This guard fails if a *.spec.ts re-introduces an inline canvas literal in either
# click idiom the specs actually use:
#   - page.locator('canvas').click({ position: { x: <num>, … } })
#   - page.mouse.click(box.x + <num> …, box.y + <num> …)
#   - a bare inline rect object literal   { x: <num>,
#   - an inline CANVAS_W / CANVAS_H constant
# Helper-driven forms PASS: .click({ position: RECT }), centerOf(RECT), and
#   page.mouse.click(box.x + r.x + r.w / 2, …) (no `+ <digit>`).
# Legit non-click numbers PASS: toHaveAttribute('width', '800'),
#   waitForTimeout(300), the 1024×768 viewport, save-fixture shapes.
#
# Scope is *.spec.ts only — tests/helpers/geometry.ts legitimately holds the rects.
#
# Run via: bash scripts/check-e2e-geometry.sh   (or npm run verify)
# Exits 0 if clean; 1 with the offending lines otherwise.

set -euo pipefail

PATTERNS=(
  '\.click\(\{ *position: *\{ *x: *[0-9]' # literal rect inside .click({ position })
  'mouse\.click\([^)]*\+ *[0-9]'          # canvas-local literal arithmetic in mouse.click
  '\{ *x: *[0-9]+ *,'                     # bare inline rect object literal
  'CANVAS_[WH]'                           # inline canvas-size constant
)

# The trailing `grep -vE ':[[:space:]]*//'` drops pure-comment lines (a comment
# may legitimately describe a rect like `{x:8,y:8,w:200,h:24}` — not a click).
HITS=""
for pat in "${PATTERNS[@]}"; do
  found=$(grep -rnE "$pat" tests --include='*.spec.ts' | grep -vE ':[[:space:]]*//' || true)
  [[ -n "$found" ]] && HITS+="$found"$'\n'
done

if [[ -n "${HITS//[$'\n']/}" ]]; then
  echo "Inline canvas-pixel geometry in an E2E spec (#240) — import it from tests/helpers/geometry.ts:"
  echo "$HITS"
  exit 1
fi
echo "E2E geometry guard: clean."
