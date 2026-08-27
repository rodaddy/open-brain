#!/usr/bin/env bash
# Fails when a Graph Mode artifact still carries an unresolved scaffold
# placeholder, so "I scaffolded it" is a failing state, not an empty pass.
#
# usage: check.sh [--allow <literal>]... <file>...
# exit:  0 pass (files examined, no hits)
#        1 at least one unresolved placeholder
#        3 harness error (no files, missing file, tool missing)
set -u

ALLOW_LIST=""
FILES=""
SEP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --allow)
      if [ $# -lt 2 ]; then
        echo "HARNESS ERROR: --allow needs a literal" >&2
        exit 3
      fi
      ALLOW_LIST="$ALLOW_LIST$2
"
      shift 2
      ;;
    -h|--help)
      echo "usage: check.sh [--allow <literal>]... <file>..."
      exit 0
      ;;
    --)
      shift
      while [ $# -gt 0 ]; do
        FILES="$FILES$SEP$1"; SEP="
"
        shift
      done
      ;;
    *)
      FILES="$FILES$SEP$1"; SEP="
"
      shift
      ;;
  esac
done

if [ -z "$FILES" ]; then
  echo "HARNESS ERROR: no files to examine" >&2
  exit 3
fi

command -v awk >/dev/null 2>&1 || { echo "HARNESS ERROR: awk not found" >&2; exit 3; }

# Validate every listed path before examining any of them.
OLDIFS=$IFS
IFS='
'
for f in $FILES; do
  if [ ! -f "$f" ]; then
    IFS=$OLDIFS
    echo "HARNESS ERROR: file does not exist: $f" >&2
    exit 3
  fi
done
IFS=$OLDIFS

# One awk pass over every file. Fenced code blocks are NOT exempt.
IFS='
'
set -f
# shellcheck disable=SC2086
OUTPUT=`PH_ALLOW="$ALLOW_LIST" awk '
  BEGIN {
    n = 0
    lit[++n] = "REPLACE_"
    lit[++n] = "<scope>"
    lit[++n] = "<slug>"
    lit[++n] = "<repo>"
    lit[++n] = "<owner>"
    lit[++n] = "<lane-name>"
    lit[++n] = "<YYYY-MM-DD>"
    lit[++n] = "<date>"
    lit[++n] = "TODO-FILL"
    lit[++n] = "FILL ME"
    lit[++n] = "FILLME"
    nlit = n
    na = split(ENVIRON["PH_ALLOW"], atmp, "\n")
    for (i = 1; i <= na; i++) if (atmp[i] != "") allowed[atmp[i]] = 1
  }
  {
    line = $0
    for (i = 1; i <= nlit; i++) {
      t = lit[i]
      if (t in allowed) continue
      if (index(line, t) > 0) print FILENAME ":" FNR ": " t
    }
    if (!("TBD" in allowed) && line ~ /(^|[^A-Za-z0-9_])TBD([^A-Za-z0-9_]|$)/)
      print FILENAME ":" FNR ": TBD"
    if (!("XXX" in allowed) && line ~ /(^|[^A-Za-z0-9_])XXX([^A-Za-z0-9_]|$)/)
      print FILENAME ":" FNR ": XXX"
    rest = line
    while (match(rest, /\{\{[^{}]*\}\}/)) {
      m = substr(rest, RSTART, RLENGTH)
      if (!(m in allowed) && !("{{...}}" in allowed)) print FILENAME ":" FNR ": " m
      rest = substr(rest, RSTART + RLENGTH)
    }
  }
' $FILES` || { IFS=$OLDIFS; set +f; echo "HARNESS ERROR: awk failed" >&2; exit 3; }
IFS=$OLDIFS
set +f

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
  COUNT=`printf '%s\n' "$OUTPUT" | wc -l | tr -d ' '`
  echo "FAIL: $COUNT unresolved placeholder hit(s)" >&2
  exit 1
fi

echo "PASS: no unresolved placeholders"
exit 0
