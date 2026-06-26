#!/bin/bash
cd /root/.openclaw/workspace/hyperreality-system
node run-promo-full.js 2>&1 | tee output/run-promo-v4.log
