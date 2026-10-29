#!/bin/bash
# supervisor: restart driver on exit (host is spawned/reaped by lib/link.mjs)
cd "$(dirname "$0")"
while :; do
    node driver.mjs >> out/drv-stdout.txt 2>&1
    echo "$(date -u +%H:%M:%S) driver exited, restarting" >> out/drv-stdout.txt
    sleep 5
done
