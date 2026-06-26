#!/bin/bash

PUID=${PUID:-1000}
PGID=${PGID:-1000}
export MIMOCODE_SERVER_PASSWORD="${MIMOCODE_SERVER_PASSWORD:-}"

if [ "$(id -g node)" -ne "$PGID" ]; then
    groupmod -o -g "$PGID" node
fi

if [ "$(id -u node)" -ne "$PUID" ]; then
    usermod -o -u "$PUID" node
fi

chown -R node:node /home/node/.local/share/mimocode
chown -R node:node /home/node/.config/mimocode
chown -R node:node /home/node/project

PROXY_PORT=${MIMOCODE_PROXY_PORT:-10000}
SERVER_PORT=${MIMOCODE_SERVER_PORT:-10001}

if [[ "$1" == "mimo" && "$2" == "serve" ]]; then
    echo "Initializing MiMoCode2API (Server + Proxy)"

    echo "Starting MiMo Server on internal port ${SERVER_PORT}..."
    gosu node mimo serve --hostname 0.0.0.0 --port ${SERVER_PORT} &
    SERVER_PID=$!

    echo "Waiting for MiMo Server to become available..."
    MAX_RETRIES=30
    COUNT=0
    HEALTH_URL="http://127.0.0.1:${SERVER_PORT}/health"
    CURL_ARGS=(-s -o /dev/null -w "%{http_code}")
    if [ -n "$MIMOCODE_SERVER_PASSWORD" ]; then
        CURL_ARGS+=(-u "mimocode:${MIMOCODE_SERVER_PASSWORD}")
    fi
    while true; do
        HEALTH_STATUS=$(curl "${CURL_ARGS[@]}" "$HEALTH_URL" || true)
        if [[ "$HEALTH_STATUS" == "200" || "$HEALTH_STATUS" == "503" ]]; then
            break
        fi

        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo "Timeout waiting for MiMo Server."
            kill $SERVER_PID 2>/dev/null
            exit 1
        fi

        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "MiMo Server process died unexpectedly."
            exit 1
        fi

        sleep 1
        COUNT=$((COUNT+1))
    done
    echo "MiMo Server is up!"

    echo "Starting OpenAI Proxy on port ${PROXY_PORT}..."
    exec gosu node node index.js
else
    exec gosu node "$@"
fi
