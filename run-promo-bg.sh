#!/bin/bash
cd /root/.openclaw/workspace/hyperreality-system
# 使用nohup在后台运行，避免被SIGTERM
nohup node run-promo.js > output/run-promo-final.log 2>&1 &
echo "PID: $!"
