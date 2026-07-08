#!/usr/bin/env bash
# scripts/check-layout-discipline.sh
# #238 LayoutContext discipline guard — the grep backstop that proves the
# CANVAS_W/CANVAS_H drain (issue #238 PR2/PR3) stays drained. HUD / overlay /
# camera geometry must be a pure function of a LayoutContext (see code/AGENTS.md
# → "Layout discipline"), NOT of the fixed 800×592 canvas constants. This guard
# fails if render/input code reintroduces either:
#   1. a bare 800 / 592 canvas-size literal, or
#   2. an `import … CANVAS_W/CANVAS_H` outside the sanctioned authority files.
#
# Mirrors check-sim-boundary.sh / check-asset-paths.sh: BSD-compatible ERE,
# `set -euo pipefail`, `|| true` on the greps, an allowlist `grep -v` filter,
# and a clear pass/fail echo. Comment lines (`//`, `/* … */`, ` * ` JSDoc) are
# dropped first — a comment may legitimately reference the canonical 800×592
# size or the CANVAS_W/H import while the surrounding code is discipline-clean
# (mirrors the pure-comment drop in check-e2e-geometry.sh).
#
# Run via: bash scripts/check-layout-discipline.sh   (or npm run verify)
# Exits 0 if clean; exits 1 with the offending lines otherwise.

set -euo pipefail

SCOPE=(src/render src/input)
# Drop FULL-LINE comments only (//, /*, ` * ` JSDoc), anchored to grep's
# `path:line:` prefix so a mid-line comment (e.g. `x = 592 /* note */`) can't
# hide a real violation on the same line (Codex #269 F2).
COMMENT_FILTER='^[^:]*:[0-9]+:[[:space:]]*(//|/\*|\*)'

# --- Check 1: no bare 800 / 592 canvas literal -----------------------------
# File allowlist: sprites.ts (the CANVAS_W/H definitions) and layout.ts (the
# default LayoutContext). PLUS one documented non-geometry literal: the
# caption-hold tween duration `delay: 800` (ms) in ui-scene.ts — a timing value
# that merely collides with the canvas width, not a geometry literal (#238).
NUM_HITS=$( { grep -rnE '\b(800|592)\b' "${SCOPE[@]}" --include='*.ts' --exclude='*.test.ts' || true; } \
  | grep -vE "$COMMENT_FILTER" \
  | grep -vE '/(sprites|layout)\.ts:' \
  | grep -vE '/ui-scene\.ts:[0-9]+:[[:space:]]*delay: 800,' \
  || true )

if [[ -n "$NUM_HITS" ]]; then
  echo "Layout discipline (#238): bare 800/592 canvas literal in render/input code:"
  echo "$NUM_HITS"
  echo ""
  echo "Derive canvas-relative geometry from a LayoutContext (layout.w / layout.h),"
  echo "not the fixed 800×592 constants. The canvas-size defs live in sprites.ts."
  exit 1
fi
echo "layout-discipline bare-800/592 guard: clean."

# --- Check 2: no CANVAS_W/CANVAS_H USE outside the authority files ----------
# Match any CANVAS_W/CANVAS_H *reference*, not just a single-line `import …`
# statement (CodeRabbit #269): a multiline named-import member or a
# `sprites.CANVAS_W` namespace access would evade an import-only pattern while
# still coupling render/input geometry to the fixed canvas size.
# File allowlist: sprites.ts (defines them), layout.ts (the default-context
# seam), camera-adapter.ts (the screen↔world authority — AGENTS.md §"Layout
# discipline" sanctions its canvas-size dependency), and camera.ts (owns the
# underground initial-center-Y = CANVAS_H/2 dependency; deferred adapter-owned
# move tracked in #270). src/main.ts is outside SCOPE (render/input), so no entry.
USE_HITS=$( { grep -rnE '\bCANVAS_[WH]\b' "${SCOPE[@]}" --include='*.ts' --exclude='*.test.ts' || true; } \
  | grep -vE "$COMMENT_FILTER" \
  | grep -vE '/(sprites|layout|camera-adapter|camera)\.ts:' \
  || true )

if [[ -n "$USE_HITS" ]]; then
  echo "Layout discipline (#238): CANVAS_W/CANVAS_H used outside the authority files:"
  echo "$USE_HITS"
  echo ""
  echo "Only sprites.ts / layout.ts / camera-adapter.ts / camera.ts may reference"
  echo "CANVAS_W/CANVAS_H. Elsewhere, take a LayoutContext and derive from layout.w / layout.h."
  exit 1
fi
echo "layout-discipline CANVAS-use guard: clean."

echo "Layout-discipline guard: clean."
