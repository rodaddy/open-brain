#!/opt/homebrew/bin/bash
# Read-only compliance audit of open-brain against _DOCS/CODING_STANDARDS.md
# and _DOCS/STANDARDS-typescript.md. Counts only. Changes nothing.
set -uo pipefail
# `set -e` is deliberately absent (the audit tolerates individual probes
# failing), so this cd must guard itself -- otherwise a bad path silently
# audits whatever directory the caller happened to be in.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
WORK="${OB_SCRATCH:-/Volumes/ThunderBolt/_tmp/open-brain/_scratch}"
mkdir -p "$WORK"

echo "=== 1. ENFORCEMENT (step 1 of the migration order) ==="
printf 'core.hooksPath : %s\n' "$(git config core.hooksPath || echo '(unset)')"
printf '_githooks/     : %s\n' "$(test -d _githooks && echo present || echo MISSING)"
printf 'oxlint config  : %s\n' "$(test -f .oxlintrc.json && echo present || echo MISSING)"
printf 'prettier config: %s\n' "$(test -f .prettierrc.json && echo present || echo MISSING)"
printf 'tsconfig       : %s\n' "$(test -f tsconfig.json && echo present || echo MISSING)"

echo ""
echo "=== 2. PINNED RUNTIME (Node 24 discipline, 4 files) ==="
printf 'engines.node in package.json : %s\n' "$(rg -o '"node"[^,}]*' package.json 2>/dev/null | head -1 || echo MISSING)"
printf '.npmrc engine-strict         : %s\n' "$(test -f .npmrc && rg -o 'engine-strict=.*' .npmrc || echo MISSING)"
printf 'package-lock.json            : %s\n' "$(test -f package-lock.json && echo present || echo MISSING)"
printf '.node-version                : %s\n' "$(test -f .node-version && cat .node-version || echo MISSING)"
printf 'bun.lock (should be retired) : %s\n' "$(test -f bun.lock && echo present || echo absent)"

echo ""
echo "=== 3. TYPE STRIPPING FLAGS ==="
printf 'erasableSyntaxOnly    : %s\n' "$(rg -o 'erasableSyntaxOnly.*' tsconfig.json 2>/dev/null || echo MISSING)"
printf 'verbatimModuleSyntax  : %s\n' "$(rg -o 'verbatimModuleSyntax.*' tsconfig.json 2>/dev/null || echo MISSING)"
printf 'TS enum declarations  : %s\n' "$(rg -c '^\s*(export )?enum ' src server 2>/dev/null | wc -l | tr -d ' ')"
printf 'namespace declarations: %s\n' "$(rg -c '^\s*(export )?namespace ' src server 2>/dev/null | wc -l | tr -d ' ')"

echo ""
echo "=== 4. SIZE (500 code lines/file, raw count as upper bound) ==="
fd -e ts . src server --max-depth 4 2>/dev/null | rg -v '\.test\.|__tests__' > "$WORK/_prod.txt"
printf 'production .ts files        : %s\n' "$(wc -l < "$WORK/_prod.txt" | tr -d ' ')"
printf 'files over 500 raw lines    : %s\n' "$(xargs wc -l < "$WORK/_prod.txt" 2>/dev/null | rg -v ' total$' | awk '$1>500' | wc -l | tr -d ' ')"
printf 'files over 1000 raw lines   : %s\n' "$(xargs wc -l < "$WORK/_prod.txt" 2>/dev/null | rg -v ' total$' | awk '$1>1000' | wc -l | tr -d ' ')"

echo ""
echo "=== 5. OBSERVABILITY ==="
printf 'console.* calls (non-test)  : %s\n' "$(rg -c 'console\.(log|warn|error|info|debug)' src server 2>/dev/null | rg -v '\.test\.' | awk -F: '{s+=$2} END {print s+0}')"
printf 'files importing pino        : %s\n' "$(rg -l 'from "pino' src server 2>/dev/null | wc -l | tr -d ' ')"
printf 'files importing src/logger  : %s\n' "$(rg -l 'logger' src server 2>/dev/null | rg -v '\.test\.' | wc -l | tr -d ' ')"

echo ""
echo "=== 6. CONFIG (one module, no scattered process.env) ==="
printf 'files reading process.env   : %s\n' "$(rg -l 'process\.env' src server 2>/dev/null | rg -v '\.test\.' | wc -l | tr -d ' ')"

echo ""
echo "=== 7. TYPING ==="
printf 'explicit any (non-test)     : %s\n' "$(rg -c ': any\b|<any>|as any' src server 2>/dev/null | rg -v '\.test\.' | awk -F: '{s+=$2} END {print s+0}')"
printf 'non-null assertions         : %s\n' "$(rg -c '\w!\.|\w!\[|\w!\)|\w!;' src server 2>/dev/null | rg -v '\.test\.' | awk -F: '{s+=$2} END {print s+0}')"

echo ""
echo "=== 8. CI ==="
printf 'workflows with permissions: : %s of %s\n' \
  "$(rg -l '^permissions:' .github/workflows/*.yml 2>/dev/null | wc -l | tr -d ' ')" \
  "$(fd -e yml . .github/workflows 2>/dev/null | wc -l | tr -d ' ')"
printf 'actions pinned by SHA       : %s\n' "$(rg -o 'uses: [^@]+@[a-f0-9]{40}' .github/workflows/*.yml 2>/dev/null | wc -l | tr -d ' ')"
printf 'actions pinned by tag       : %s\n' "$(rg -o 'uses: [^@]+@v[0-9]' .github/workflows/*.yml 2>/dev/null | wc -l | tr -d ' ')"
