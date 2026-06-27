#!/bin/bash
cd /root/.openclaw/workspace/hyperreality-system
node run-promo-final.js 2>&1 | tee output/run-promo-v7.log
