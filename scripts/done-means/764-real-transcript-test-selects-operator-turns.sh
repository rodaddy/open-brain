#!/usr/bin/env bash
# DONE-MEANS check for #764: the real-transcript test is deterministic.
#
#   bash scripts/done-means/764-real-transcript-test-selects-operator-turns.sh
#
# WHAT THIS GATES
#
# python/openbrain/tests/test_capture_transcript.py::TestAgainstARealTranscript
# used to read whatever *.jsonl file was LARGEST under the runner's ~/.claude.
# That made the outcome a property of the host, not of the code: when the
# biggest session on a runner was one in which every `user` record was an API
# error, zero operator turns were found and `assert 1 < 1` failed. It hit five
# unrelated PRs on 2026-08-27 (#873 #875 #883 #885 #886).
#
# The fix points the class at a committed fixture. So a passing pytest run is
# not enough on its own — it would also pass on a developer machine whose
# largest live transcript happens to be healthy. C1 and C3 are what prove the
# host is out of the loop.
set -euo pipefail

cd "$(dirname "$0")/../.."

TEST_FILE="python/openbrain/tests/test_capture_transcript.py"
FIXTURE="python/openbrain/tests/fixtures/transcripts/session-with-operator-turns.jsonl"
EMPTY_HOME="/Volumes/ThunderBolt/_tmp/open-brain/_scratch/session7/empty-home"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# C1: selection is by committed fixture, not by file size on the host.
if rg -q "largest_transcript|st_size > 0|LIVE_TRANSCRIPT_DIR" "$TEST_FILE"; then
  fail "C1 $TEST_FILE still selects a transcript from the host"
fi
rg -q "FIXTURE_TRANSCRIPT" "$TEST_FILE" ||
  fail "C1 $TEST_FILE does not reference the committed fixture"
[ -s "$FIXTURE" ] || fail "C1 fixture missing or empty: $FIXTURE"
echo "C1 ok: the test loads $FIXTURE and no longer selects by size"

# C2: the class passes.
(cd python/openbrain && uv run pytest -q tests/test_capture_transcript.py \
  -k TestAgainstARealTranscript) ||
  fail "C2 pytest -k TestAgainstARealTranscript did not exit 0"
echo "C2 ok: TestAgainstARealTranscript passes"

# C3: it passes just the same with no ~/.claude to find.
mkdir -p "$EMPTY_HOME"
(cd python/openbrain && HOME="$EMPTY_HOME" uv run pytest -q \
  tests/test_capture_transcript.py -k TestAgainstARealTranscript) ||
  fail "C3 the class depends on the machine's ~/.claude"
echo "C3 ok: passes with HOME=$EMPTY_HOME"

echo "DONE-MEANS 764: PASS"
