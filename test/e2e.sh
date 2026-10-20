#!/bin/sh
# End-to-end check against test/mock-chat.html with headless Chrome. No real chat service is touched.

cd "$(dirname "$0")/.."
curl -sf localhost:8798/health >/dev/null && { echo "port 8798 already in use"; exit 1; }
python3 -m http.server 8799 -d test >/dev/null 2>&1 & WEB=$!
PROFILE=$(mktemp -d)
SITE=mock SITES_FILE=test/mock-sites.json PORT=8798 HEADLESS=1 PROFILE_DIR=$PROFILE STABLE_MS=500 node src/server.ts >server.log 2>&1 </dev/null & SRV=$!
cleanup() { kill $WEB $SRV 2>/dev/null; wait $SRV 2>/dev/null; rm -rf $PROFILE; }
trap cleanup EXIT INT TERM
for i in $(seq 1 30); do curl -sf localhost:8798/health >/dev/null && break; sleep 1; done
node test/e2e.ts; RC=$?; cleanup; exit $RC
