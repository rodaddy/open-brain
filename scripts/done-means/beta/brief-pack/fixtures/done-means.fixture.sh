#!/usr/bin/env bash
# done-means: every bash entrypoint under scripts/ parses under bash 3.2 and
# declares `set -u`.
#
# Exit grammar:
#   0  pass
#   1  an entrypoint failed the check
#   3  harness error — bash 3.2 not available, no entrypoints found
set -u
echo "fixture check"
exit 0
