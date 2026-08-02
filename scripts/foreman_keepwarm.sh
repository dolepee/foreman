#!/bin/zsh
# Keep the Foreman x402 endpoint warm and keep an uptime trail.
# OKX review probes have twice returned "service endpoint is unreachable";
# a 5-minute HEAD cadence removes cold starts as a cause and logs evidence.
set -u

ENDPOINT="https://okx-agent-review-relay.onrender.com/foreman/api/launch-readiness-pack"
LOG="/Users/qdee/.okx-agent-task/logs/foreman-keepwarm.log"

result=$(curl -sS -o /dev/null -I --max-time 20 \
  -w '%{http_code} %{time_total}s' "$ENDPOINT" 2>&1) || result="FAIL $result"
printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$result" >> "$LOG"

# Rotate: keep the last 2000 lines (~1 week at 5-minute cadence).
if [ "$(wc -l < "$LOG")" -gt 2500 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
