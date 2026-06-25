#!/usr/bin/env bash
set -euo pipefail

QMD_ROOT="${QMD_ROOT:-/Volumes/ThunderBolt/qmd}"
QMD_VERSION="${QMD_VERSION:-2.1.0}"
BUN_BIN="${BUN_BIN:-}"

if [[ -z "$BUN_BIN" ]]; then
  if [[ -x "/Users/rico/Library/Application Support/reflex/bun/bin/bun" ]]; then
    BUN_BIN="/Users/rico/Library/Application Support/reflex/bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    echo "FATAL: bun not found" >&2
    exit 1
  fi
fi

mkdir -p "$QMD_ROOT/app" "$QMD_ROOT/bin" "$QMD_ROOT/cache" "$QMD_ROOT/config" "$QMD_ROOT/logs"

cat > "$QMD_ROOT/app/package.json" <<EOF
{"name":"core01-qmd-runtime","private":true,"type":"module","dependencies":{"@tobilu/qmd":"$QMD_VERSION"}}
EOF

"$BUN_BIN" install --cwd "$QMD_ROOT/app"

cat > "$QMD_ROOT/bin/qmd" <<'EOF'
#!/bin/zsh
export XDG_CACHE_HOME="/Volumes/ThunderBolt/qmd/cache"
export PATH="/Users/rico/Library/Application Support/reflex/bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "/Volumes/ThunderBolt/qmd/app/node_modules/@tobilu/qmd/bin/qmd" --index open-brain "$@"
EOF
chmod 755 "$QMD_ROOT/bin/qmd"

cat > "$QMD_ROOT/open-brain-qmd.ts" <<'EOF'
#!/usr/bin/env bun
const args = Bun.argv.slice(2);
const proc = Bun.spawn(["/Volumes/ThunderBolt/qmd/bin/qmd", ...args], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    XDG_CACHE_HOME: "/Volumes/ThunderBolt/qmd/cache",
    PATH:
      "/Users/rico/Library/Application Support/reflex/bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  },
});
process.exit(await proc.exited);
EOF
chmod 755 "$QMD_ROOT/open-brain-qmd.ts"

"$QMD_ROOT/bin/qmd" status
