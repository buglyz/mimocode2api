# MiMoCode2API

![Node](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![MiMo](https://img.shields.io/badge/MiMo%20Auto-free-success)

An OpenAI-compatible API gateway for the [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) CLI, enabling the use of the free `mimo-auto` model in any standard OpenAI API client.

## Quick Start

```bash
# Clone
git clone https://github.com/Sliverkiss/mimocode2api.git
cd mimocode2api

# Docker (recommended)
docker compose up -d

# Or run locally
npm install
MIMOCODE_SERVER_URL=http://127.0.0.1:10001 node index.js
```

## Usage

Once running, point any OpenAI-compatible client to `http://localhost:10000/v1`:

```bash
curl http://localhost:10000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo/mimo-auto",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## Architecture

```
Client (OpenAI API format)
    │
    ▼
┌── Node.js Proxy (port 10000) ──────────────────┐
│  Express server                                  │
│  /v1/chat/completions  → mimo SDK session+events │
│  /v1/models            → mimo config providers   │
│  /health               → health check            │
└──────────────────────────────────────────────────┘
    │
    ▼
┌── mimo serve (port 10001, internal) ───────────┐
│  @mimo-ai/cli headless server                    │
│  MIMOCODE_MIMO_ONLY=true (free channel only)     │
│  Default model: mimo/mimo-auto (1M context)      │
└──────────────────────────────────────────────────┘
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MIMOCODE_PROXY_PORT` | `10000` | Proxy external port |
| `MIMOCODE_SERVER_PORT` | `10001` | MiMo server internal port |
| `MIMOCODE_SERVER_URL` | `http://127.0.0.1:10001` | MiMo server URL |
| `API_KEY` | (empty) | Proxy auth key (empty = no auth) |
| `MIMOCODE_SERVER_PASSWORD` | (auto) | MiMo server auth (auto-generated in Docker) |
| `DISABLE_TOOLS` | `true` | Disable tool calls (API-only mode) |
| `MIMOCODE_PROXY_DEBUG` | `false` | Enable debug logging |
| `MIMOCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | Request timeout |
| `MIMOCODE_MIMO_ONLY` | `true` | Free channel only (no paid models) |
| `MIMOCODE_PROXY_MANAGE_BACKEND` | `true` | Auto-start/stop mimo serve |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (stream & non-stream) |

## Features

- **OpenAI-compatible** — works with any OpenAI API client
- **Free model access** — `mimo/mimo-auto` (1M context, zero cost)
- **Streaming support** — SSE with fallback to polling
- **Multi-turn conversations** — full message history support
- **Image support** — multimodal image input via data URI
- **Reasoning output** — `<think>` blocks for reasoning models
- **Docker-ready** — one command deployment

## Disclaimer

This project is for educational purposes. MiMo Auto is a free-for-limited-time channel provided by Xiaomi. Respect their terms of service and rate limits.
