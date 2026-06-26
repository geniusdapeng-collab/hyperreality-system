#!/bin/bash
cd /root/.openclaw/workspace/hyperreality-system
node run-promo.js > output/run-promo.log 2>&1
echo "Exit code: $?"
