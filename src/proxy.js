import express from 'express';
import cors from 'cors';
import { createOpencodeClient } from '@opencode-ai/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { buildExternalToolRegistry, findExternalToolByName } from './tool-runtime/registry.js';
import { buildToolExposure, normalizeExternalToolChoice } from './tool-runtime/router.js';
import { evaluateToolPolicy } from './tool-runtime/policy.js';
import { validateToolCalls } from './tool-runtime/validator.js';
import {
    stripFunctionCallMarkup,
    parseExternalToolCallsFromText,
    createToolCallFilter,
    createExternalToolCallStreamParser,
    parseToolCallsFromText
} from './tool-runtime/parser.js';

// ─── Constants ───
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = 4000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 8000;
const STARTUP_WAIT_ITERATIONS = 60;
const STARTUP_WAIT_INTERVAL_MS = 2000;
const STARTING_WAIT_ITERATIONS = 120;
const STARTING_WAIT_INTERVAL_MS = 1000;

const TOOL_GUARD_MESSAGE = 'Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools.';

// ─── Utilities ───
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDebug(config, ...args) {
    if (config.DEBUG) {
        console.log('[Proxy][Debug]', ...args);
    }
}

async function getImageDataUri(url) {
    if (url.startsWith('data:')) return url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid URL scheme: ${url}`);
    }
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const req = protocol.get(url, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch image: HTTP ${res.statusCode}`));
            }
            const contentType = res.headers['content-type'] || 'image/jpeg';
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    resolve(`data:${contentType};base64,${base64}`);
                } catch (e) {
                    reject(new Error(`Failed to encode image: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Image fetch timeout'));
        });
    });
}

function normalizeTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('');
    }
    return '';
}

function normalizeReasoningEffort(effort, fallback) {
    if (!effort) return fallback;
    const e = String(effort).toLowerCase();
    if (['low', 'medium', 'high'].includes(e)) return e;
    if (e === 'none') return 'none';
    return fallback;
}

function normalizeToolArguments(rawArgs) {
    if (rawArgs === undefined || rawArgs === null || rawArgs === '') return '{}';
    if (typeof rawArgs === 'object') return JSON.stringify(rawArgs);
    return typeof rawArgs === 'string' ? rawArgs : '{}';
}

// ─── Mutex Queue ───
const queue = [];
let isProcessing = false;

function processQueue() {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;
    const { task, timeout, resolve, reject } = queue.shift();
    let settled = false;
    const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Request timeout after ${timeout}ms`));
    }, timeout);

    Promise.resolve()
        .then(() => task())
        .then((result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(result);
        })
        .catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
        })
        .finally(() => {
            isProcessing = false;
            if (queue.length > 0) {
                queueMicrotask(processQueue);
            }
        });
}

function lock(task, timeout = 120000) {
    return new Promise((resolve, reject) => {
        queue.push({ task, timeout, resolve, reject });
        processQueue();
    });
}

// ─── Backend Tool Disable ───
const TOOL_IDS_CACHE_MS = 5 * 60 * 1000;
let cachedDisabledToolOverrides = null;
let cachedDisabledToolOverridesAt = 0;

async function getBackendToolIds(client, config) {
    try {
        const idsRes = await client.tool.ids();
        const ids = Array.isArray(idsRes?.data) ? idsRes.data : Array.isArray(idsRes) ? idsRes : [];
        logDebug(config, 'Backend tool IDs loaded', { count: ids.length });
        return ids;
    } catch (e) {
        logDebug(config, 'Failed to get backend tool IDs:', e.message);
        return [];
    }
}

async function getDisabledToolOverrides(client, config) {
    if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
        return cachedDisabledToolOverrides;
    }
    const ids = await getBackendToolIds(client, config);
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const overrides = {};
    ids.forEach((id) => { overrides[id] = false; });
    cachedDisabledToolOverrides = overrides;
    cachedDisabledToolOverridesAt = Date.now();
    logDebug(config, 'Disabled tool overrides built', { count: ids.length });
    return overrides;
}

// ─── Backend Auth & Management ───
function buildBackendAuthHeaders(password) {
    if (!password) return undefined;
    const token = Buffer.from(`mimocode:${password}`).toString('base64');
    return { Authorization: ['Basic', token].join(' ') };
}

function checkHealth(serverUrl, password) {
    return new Promise((resolve, reject) => {
        const headers = buildBackendAuthHeaders(password);
        const options = headers ? { headers } : undefined;
        const req = http.get(`${serverUrl}/health`, options, (res) => {
            if (res.statusCode === 200 || res.statusCode === 503) resolve(true);
            else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', (e) => reject(e));
        req.setTimeout(2000, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

let backendProcess = null;
let backendStarted = false;

async function ensureBackend(config) {
    if (!config.MANAGE_BACKEND) {
        if (!backendStarted) {
            await waitForBackend(config.MIMOCODE_SERVER_URL, config.MIMOCODE_SERVER_PASSWORD, STARTUP_WAIT_ITERATIONS, STARTUP_WAIT_INTERVAL_MS);
            backendStarted = true;
        }
        return;
    }
    if (backendStarted && backendProcess) {
        try {
            await checkHealth(config.MIMOCODE_SERVER_URL, config.MIMOCODE_SERVER_PASSWORD);
            return;
        } catch {
            backendStarted = false;
            backendProcess = null;
        }
    }
    const serverPort = new URL(config.MIMOCODE_SERVER_URL).port || '10001';
    const args = ['serve', '--hostname', '127.0.0.1', '--port', serverPort];
    const env = { ...process.env, MIMOCODE_MIMO_ONLY: 'true', MIMOCODE_SERVER_PASSWORD: config.MIMOCODE_SERVER_PASSWORD };
    backendProcess = spawn(config.MIMOCODE_PATH, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    backendProcess.stdout?.on('data', (data) => { const line = data.toString().trim(); if (line) console.log(`[MiMo Backend] ${line}`); });
    backendProcess.stderr?.on('data', (data) => { const line = data.toString().trim(); if (line) console.error(`[MiMo Backend] ${line}`); });
    backendProcess.on('exit', (code) => { console.error(`[MiMo Backend] exited with code ${code}`); backendStarted = false; backendProcess = null; });
    await waitForBackend(config.MIMOCODE_SERVER_URL, config.MIMOCODE_SERVER_PASSWORD, STARTING_WAIT_ITERATIONS, STARTING_WAIT_INTERVAL_MS);
    backendStarted = true;
    console.log('[Proxy] MiMo backend is up!');
}

async function waitForBackend(url, password, maxIterations, intervalMs) {
    for (let i = 0; i < maxIterations; i++) {
        try { await checkHealth(url, password); return; } catch { await sleep(intervalMs); }
    }
    throw new Error(`Timeout waiting for MiMo backend at ${url}`);
}

// ─── Cleanup ───
function cleanupTempDirs() {
    const jailRoot = path.join(os.tmpdir(), 'mimocode-proxy-jail');
    try { if (fs.existsSync(jailRoot)) fs.rmSync(jailRoot, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanupTempDirs);
if (process.platform !== 'win32') {
    process.on('SIGINT', () => { cleanupTempDirs(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupTempDirs(); process.exit(0); });
}

// ─── Message Processing ───
function extractFromParts(parts) {
    if (!Array.isArray(parts)) return { content: '', reasoning: '' };
    const content = parts.filter(p => p.type === 'text').map(p => p.text).join('');
    const reasoning = parts.filter(p => p.type === 'reasoning').map(p => p.text).join('');
    return { content, reasoning };
}

async function buildPromptParts(rawMessages, externalToolRegistry = []) {
    const parts = [];
    const systemChunks = [];
    const userContents = [];
    const assistantToolCalls = new Map();

    const formatRoleLine = (role, name, text) => {
        const roleLabel = role.toUpperCase();
        const nameSuffix = name ? `(${name})` : '';
        return `${roleLabel}${nameSuffix}: ${text}`;
    };

    for (const m of rawMessages) {
        const role = (m?.role || 'user').toLowerCase();
        const content = m?.content;

        if (role === 'system') {
            const text = normalizeTextContent(content);
            if (text) systemChunks.push(text);
            continue;
        }

        if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
            const serialized = m.tool_calls.map((tc, index) => ({
                id: tc?.id || `call_${index + 1}`,
                name: findExternalToolByName(externalToolRegistry, tc?.function?.name || tc?.name)?.namespacedName || tc?.function?.name || tc?.name,
                arguments: normalizeToolArguments(tc?.function?.arguments ?? tc?.arguments)
            })).filter(tc => tc.name);
            if (serialized.length) {
                serialized.forEach(tc => assistantToolCalls.set(tc.id, tc.name));
                parts.push({ type: 'text', text: `ASSISTANT: <function_calls>${JSON.stringify(serialized)}</function_calls>` });
            }
        }

        if (role === 'tool') {
            const text = normalizeTextContent(content);
            if (text) {
                const mappedTool = findExternalToolByName(externalToolRegistry, m?.name)
                    || findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id));
                const toolName = mappedTool?.namespacedName || assistantToolCalls.get(m?.tool_call_id) || m?.name || 'external__unknown';
                const toolCallId = m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, '_')}`;
                parts.push({ type: 'text', text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}` });
            }
            continue;
        }

        if (!content) continue;

        if (typeof content === 'string') {
            if (role === 'user') userContents.push(content);
            parts.push({ type: 'text', text: formatRoleLine(role, m?.name, content) });
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!part) continue;
                if (part.type === 'text') {
                    const text = part.text || '';
                    if (role === 'user') userContents.push(text);
                    parts.push({ type: 'text', text: formatRoleLine(role, m?.name, text) });
                } else if (part.type === 'image_url') {
                    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                    if (imageUrl) {
                        try {
                            const dataUri = await getImageDataUri(imageUrl);
                            const mime = dataUri.split(';')[0].split(':')[1];
                            parts.push({ type: 'file', mime, url: dataUri, filename: 'image' });
                        } catch (imgErr) {
                            console.warn('[Proxy] Skipping image due to error:', imgErr.message);
                        }
                    }
                }
            }
        }
    }

    return {
        parts,
        system: systemChunks.join('\n\n'),
        fullPromptText: parts.map(p => p.text).join('\n\n'),
        lastUserMsg: userContents[userContents.length - 1] || ''
    };
}

function buildSystemPrompt(config, baseSystem, reasoningEffort, toolMode, externalToolPrompt) {
    const chunks = [];
    if (baseSystem) chunks.push(baseSystem);
    if (externalToolPrompt) chunks.push(externalToolPrompt);
    if (toolMode === 'disabled' && config.DISABLE_TOOLS) chunks.push(TOOL_GUARD_MESSAGE);
    if (reasoningEffort && reasoningEffort !== 'none') chunks.push(`Reasoning effort: ${reasoningEffort}`);
    return chunks.join('\n\n');
}

// ─── Model Resolution ───
function normalizeModelID(modelID) {
    if (!modelID || typeof modelID !== 'string') return modelID;
    return modelID.replace(/^gpt(\d)/i, 'gpt-$1').replace(/^o(\d)/i, 'o$1');
}

async function resolveRequestedModel(client, requestedModel) {
    const providersRes = await client.config.providers();
    const providersRaw = providersRes.data?.providers || [];
    const providersList = Array.isArray(providersRaw)
        ? providersRaw
        : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

    const models = [];
    providersList.forEach((p) => {
        if (p.models) {
            Object.entries(p.models).forEach(([mId, mData]) => {
                models.push({
                    id: `${p.id}/${mId}`,
                    name: typeof mData === 'object' ? (mData.name || mData.label || mId) : mId,
                    object: 'model',
                    created: (mData && mData.release_date) ? Math.floor(new Date(mData.release_date).getTime() / 1000) : 1704067200,
                    owned_by: p.id
                });
            });
        }
    });

    const fallbackModel = models[0]?.id || 'mimo/mimo-auto';
    let [providerID, modelID] = (requestedModel || fallbackModel).split('/');
    if (!modelID) { modelID = providerID; providerID = 'mimo'; }
    const normalizedModelID = normalizeModelID(modelID);
    const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))];

    const exact = models.find((m) => candidateModelIDs.some((c) => m.id === `${providerID}/${c}`));
    if (exact) {
        const [, resolvedModelID] = exact.id.split('/');
        return { providerID, modelID: resolvedModelID, models, resolved: exact.id };
    }

    const sameProvider = models.filter((m) => m.owned_by === providerID);
    const suffixMatch = sameProvider.find((m) => candidateModelIDs.some((c) => m.id.endsWith(`/${c}-free`) || m.id.endsWith(`/${c}`)));
    if (suffixMatch) {
        const [, resolvedModelID] = suffixMatch.id.split('/');
        return { providerID, modelID: resolvedModelID, models, resolved: suffixMatch.id };
    }

    if (models.find(m => m.id === 'mimo/mimo-auto')) {
        return { providerID: 'mimo', modelID: 'mimo-auto', models, resolved: 'mimo/mimo-auto' };
    }

    const error = new Error(`Model not found: ${providerID}/${modelID}`);
    error.statusCode = 400;
    error.code = 'model_not_found';
    error.availableModels = models.map((m) => m.id);
    throw error;
}

// ─── Polling & Event Collection ───
async function pollForAssistantResponse(client, config, sessionId, timeoutMs, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    const pollStart = Date.now();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const messagesRes = await client.session.messages({ path: { id: sessionId } });
        const messages = messagesRes?.data || messagesRes || [];
        if (Array.isArray(messages) && messages.length) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const entry = messages[i];
                const info = entry?.info;
                if (info?.role !== 'assistant') continue;
                const { content, reasoning } = extractFromParts(entry?.parts || []);
                const error = info?.error || null;
                const done = Boolean(info.finish || info.time?.completed || error);
                // Only return when done, or when there's actual content (not just reasoning in progress)
                if (done || content) {
                    if (error) console.error('[Proxy] MiMo assistant error:', error);
                    logDebug(config, 'Polling completed', { sessionId, ms: Date.now() - pollStart, done, contentLen: content.length, reasoningLen: reasoning.length });
                    return { content, reasoning, error };
                }
            }
        }
        await sleep(intervalMs);
    }
    throw new Error(`Request timeout after ${timeoutMs}ms`);
}

async function collectFromEvents(client, config, sessionId, timeoutMs, onDelta, firstDeltaTimeoutMs, idleTimeoutMs) {
    const controller = new AbortController();
    const eventStreamResult = await client.event.subscribe({ signal: controller.signal });
    const eventStream = eventStreamResult.stream;
    let finished = false;
    let content = '';
    let reasoning = '';
    let receivedDelta = false;
    let deltaChars = 0;
    let firstDeltaAt = null;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (finished) return;
            finished = true; controller.abort();
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const firstDeltaTimer = firstDeltaTimeoutMs ? setTimeout(() => {
            if (finished || receivedDelta) return;
            finished = true; controller.abort();
            logDebug(config, 'No event data received', { sessionId, ms: Date.now() - startedAt });
            resolve({ content: '', reasoning: '', noData: true });
        }, firstDeltaTimeoutMs) : null;

        let idleTimer = null;
        const scheduleIdleTimer = () => {
            if (!idleTimeoutMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (finished) return;
                finished = true; controller.abort();
                logDebug(config, 'Event idle timeout', { sessionId, ms: Date.now() - startedAt, deltaChars });
                resolve({ content, reasoning, idleTimeout: true, receivedDelta });
            }, idleTimeoutMs);
        };

        (async () => {
            try {
                for await (const event of eventStream) {
                    if (event.type === 'message.part.updated' && event.properties?.part?.sessionID === sessionId) {
                        const { part, delta } = event.properties;
                        if (delta) {
                            receivedDelta = true;
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            scheduleIdleTimer();
                            if (!firstDeltaAt) { firstDeltaAt = Date.now(); logDebug(config, 'SSE first delta', { sessionId, ms: firstDeltaAt - startedAt, type: part.type }); }
                            if (part.type === 'reasoning') { reasoning += delta; onDelta(delta, true); }
                            else { content += delta; onDelta(delta, false); }
                            deltaChars += delta.length;
                        }
                    }
                    if (event.type === 'message.updated' && event.properties?.info?.sessionID === sessionId && event.properties.info.finish === 'stop') {
                        if (!finished) {
                            finished = true; clearTimeout(timeoutId);
                            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                            if (idleTimer) clearTimeout(idleTimer);
                            logDebug(config, 'SSE completed', { sessionId, ms: Date.now() - startedAt, deltaChars });
                            resolve({ content, reasoning });
                        }
                        break;
                    }
                }
            } catch (e) {
                if (!finished) {
                    finished = true; clearTimeout(timeoutId);
                    if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
                    if (idleTimer) clearTimeout(idleTimer);
                    reject(e);
                }
            }
        })();
    });
}

// ─── SSE Chunk Helper ───
function sseChunk(id, model, delta, finishReason = null) {
    return `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`;
}

// ─── Tool Call Helpers ───
function toPublicToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
    return toolCalls.map((tc) => ({
        id: tc.id, type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
    }));
}

function finalizeValidatedToolCalls(parsedToolCalls, registry, config) {
    const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry);
    invalidCalls.forEach(({ call, validation }) => {
        logDebug(config, 'Rejected external tool call', {
            tool: call?.function?.name,
            errors: validation?.errors?.map((e) => e.message)
        });
    });
    const allowedCalls = [];
    validCalls.forEach((tc) => {
        const policyDecision = evaluateToolPolicy(tc.tool, tc.validatedArguments, { config });
        if (policyDecision.status === 'allow') {
            allowedCalls.push(tc);
        } else {
            logDebug(config, 'Blocked external tool call', {
                tool: tc.function.name, status: policyDecision.status, reason: policyDecision.reason
            });
        }
    });
    return { validCalls: allowedCalls, invalidCalls };
}

function stripFunctionCalls(text) {
    if (!text) return text;
    // Strip XML-tagged function calls
    let cleaned = text.replace(/<function_calls?>[\s\S]*?<\/function_calls?>/g, '');
    // Strip bare JSON tool calls: {"name":"external__...","arguments":{...}}
    cleaned = cleaned.replace(/\{[^{}]*"name"\s*:\s*"external__[^"]+"[^{}]*"arguments"\s*:\s*\{[^{}]*\}[^{}]*\}/g, '');
    return cleaned.trim();
}

// ─── Create App ───
export function createApp(config) {
    const app = express();
    app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
    app.use(express.json({ limit: '50mb' }));

    const clientHeaders = buildBackendAuthHeaders(config.MIMOCODE_SERVER_PASSWORD);
    const client = createOpencodeClient({ baseUrl: config.MIMOCODE_SERVER_URL, headers: clientHeaders });

    // Auth middleware
    app.use((req, res, next) => {
        if (req.method === 'OPTIONS' || req.path === '/health' || req.path === '/' || req.path === '/v1/models') return next();
        if (config.API_KEY && config.API_KEY.trim() !== '') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${config.API_KEY}`) {
                return res.status(401).json({ error: { message: 'Unauthorized' } });
            }
        }
        next();
    });

    // Health
    app.get('/health', (_req, res) => res.json({ status: 'ok', proxy: true }));
    app.get('/', (_req, res) => res.json({ status: 'ok', proxy: true }));

    // Models
    app.get('/v1/models', async (_req, res) => {
        try {
            const providersRes = await client.config.providers();
            const providersRaw = providersRes.data?.providers || [];
            const providersList = Array.isArray(providersRaw) ? providersRaw : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));
            const models = [];
            providersList.forEach((p) => {
                if (p.models) {
                    Object.entries(p.models).forEach(([mId, mData]) => {
                        models.push({
                            id: `${p.id}/${mId}`,
                            name: typeof mData === 'object' ? (mData.name || mData.label || mId) : mId,
                            object: 'model',
                            created: (mData && mData.release_date) ? Math.floor(new Date(mData.release_date).getTime() / 1000) : 1704067200,
                            owned_by: p.id
                        });
                    });
                }
            });
            res.json({ object: 'list', data: models });
        } catch (error) {
            console.error('[Proxy] Model Fetch Error:', error.message);
            res.json({ object: 'list', data: [{ id: 'mimo/mimo-auto', object: 'model', owned_by: 'mimo' }] });
        }
    });

    // Chat completions
    app.post('/v1/chat/completions', async (req, res) => {
        try {
            await lock(async () => {
                let sessionId = null;
                let stream = false;
                let pID = 'mimo';
                let mID = 'mimo-auto';
                let id = `chatcmpl-${Date.now()}`;
                let insideReasoning = false;
                let keepaliveInterval = null;

                try {
                    const { messages, model, tools = [], tool_choice, stream: requestStream, temperature, max_tokens, top_p, stop, reasoning_effort, reasoning } = req.body;
                    stream = Boolean(requestStream);

                    if (!messages || !Array.isArray(messages) || messages.length === 0) {
                        return res.status(400).json({ error: { message: 'messages array is required' } });
                    }

                    const reasoningLevel = normalizeReasoningEffort(reasoning_effort || reasoning?.effort, null);

                    // Build external tool registry
                    const externalToolRegistry = buildExternalToolRegistry(tools);
                    const externalToolExposure = buildToolExposure(externalToolRegistry, tool_choice);
                    const externalToolChoice = externalToolExposure.toolChoice;

                    const hasExternalTools = externalToolRegistry.length > 0;
                    const toolMode = (!config.DISABLE_TOOLS && hasExternalTools) ? 'external-bridge' : 'disabled';

                    logDebug(config, 'Tool mode', { toolMode, externalTools: externalToolRegistry.length, toolChoice: tool_choice });

                    const resolvedModel = await resolveRequestedModel(client, model);
                    pID = resolvedModel.providerID;
                    mID = resolvedModel.modelID;

                    const { parts, system: systemMsg, fullPromptText } = await buildPromptParts(messages, externalToolRegistry);

                    const systemWithGuard = buildSystemPrompt(
                        config, systemMsg, reasoningLevel,
                        toolMode,
                        hasExternalTools ? externalToolExposure.prompt : null
                    );

                    if (!parts.length) {
                        return res.status(400).json({ error: { message: 'messages must include at least one non-system text message' } });
                    }

                    logDebug(config, 'Request start', {
                        model: `${pID}/${mID}`, stream, userMessages: messages.length,
                        system: Boolean(systemMsg), parts: parts.length, toolMode, externalTools: externalToolRegistry.length
                    });

                    await ensureBackend(config);

                    try {
                        await client.config.update({ body: { activeModel: { providerID: pID, modelID: mID } } });
                    } catch (confError) {
                        logDebug(config, 'Failed to set active model:', confError.message);
                    }

                    const sessionRes = await client.session.create();
                    sessionId = sessionRes.data?.id;
                    if (!sessionId) throw new Error('Failed to create MiMo session');
                    logDebug(config, 'Session created', { sessionId });

                    id = `chatcmpl-${Date.now()}`;
                    const modelStr = `${pID}/${mID}`;

                    // Disable all backend built-in tools so only external (client) tools work
                    const disabledToolOverrides = await getDisabledToolOverrides(client, config);

                    const promptParams = {
                        path: { id: sessionId },
                        body: {
                            model: { providerID: pID, modelID: mID },
                            system: systemWithGuard,
                            parts: parts,
                            ...(typeof temperature === 'number' && { temperature }),
                            ...(typeof top_p === 'number' && { top_p }),
                            ...(typeof max_tokens === 'number' && { max_tokens }),
                            ...(stop && { stop }),
                            ...(disabledToolOverrides && { tools: disabledToolOverrides })
                        }
                    };

                    if (stream) {
                        // ─── Streaming Response ───
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');

                        let streamedContent = '';
                        let streamedReasoning = '';
                        let rawStreamedContent = '';
                        let rawStreamedReasoning = '';
                        let completionTokens = 0;
                        let reasoningTokens = 0;
                        const streamedToolCalls = [];

                        const shouldStripStreamingToolMarkup = hasExternalTools;
                        const filterContentDelta = createToolCallFilter({ disableTools: config.DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const filterReasoningDelta = createToolCallFilter({ disableTools: config.DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup });
                        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry);
                        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry);

                        const ensureKeepalive = () => {
                            if (!keepaliveInterval) {
                                keepaliveInterval = setInterval(() => {
                                    if (!res.destroyed) res.write(': keepalive\n\n');
                                }, 15000);
                            }
                        };
                        ensureKeepalive();

                        let sendDelta = (delta, isReasoning = false) => {
                            if (!delta) return;
                            if (isReasoning) rawStreamedReasoning += delta;
                            else rawStreamedContent += delta;

                            // Skip incremental tool call parsing — it produces incomplete results.
                            // Tool calls are parsed from the full text after collection completes.

                            const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta);
                            if (!filtered) return;

                            if (isReasoning) {
                                // Don't send reasoning as content delta — Hermes treats  exposes blocks
                                // as thinking-only responses. Just accumulate for tool call parsing.
                                streamedReasoning += filtered;
                                reasoningTokens += Math.ceil(filtered.length / 4);
                            } else {
                                streamedContent += filtered;
                                completionTokens += Math.ceil(filtered.length / 4);
                                res.write(sseChunk(id, modelStr, { content: filtered }));
                            }
                        };

                        // SSE-first approach: subscribe to event stream BEFORE sending prompt
                        // to avoid missing early events. Fall back to polling if SSE fails.
                        let collected = null;
                        try {
                            // 1. Subscribe to SSE event stream first
                            const sseController = new AbortController();
                            const eventStreamResult = await client.event.subscribe({ signal: sseController.signal });
                            const eventStream = eventStreamResult.stream;
                            let sseFinished = false;
                            let sseContent = '';
                            let sseReasoning = '';
                            let sseReceivedDelta = false;

                            // 2. Start SSE consumer in background
                            const ssePromise = (async () => {
                                try {
                                    // Map partID -> part type (reasoning/text) from part.updated events
                                    const partTypeMap = new Map();
                                    for await (const event of eventStream) {
                                        if (event.type === 'message.part.updated' && event.properties?.part?.sessionID === sessionId) {
                                            const { part, delta } = event.properties;
                                            // Track part type by partID
                                            if (part?.id && part?.type) {
                                                partTypeMap.set(part.id, part.type);
                                            }
                                            // Some part.updated events also carry delta
                                            if (delta) {
                                                sseReceivedDelta = true;
                                                const partType = part?.type || 'text';
                                                if (partType === 'reasoning') {
                                                    sseReasoning += delta;
                                                    sendDelta(delta, true);
                                                } else {
                                                    sseContent += delta;
                                                    sendDelta(delta, false);
                                                }
                                            }
                                        }
                                        // message.part.delta carries the actual incremental text
                                        if (event.type === 'message.part.delta') {
                                            const props = event.properties;
                                            if (props?.sessionID === sessionId && props?.delta) {
                                                sseReceivedDelta = true;
                                                // Determine if this delta is for reasoning or text part
                                                const partType = partTypeMap.get(props.partID) || 'text';
                                                if (partType === 'reasoning') {
                                                    sseReasoning += props.delta;
                                                    sendDelta(props.delta, true);
                                                } else {
                                                    sseContent += props.delta;
                                                    sendDelta(props.delta, false);
                                                }
                                            }
                                        }
                                        if (event.type === 'message.updated' &&
                                            event.properties?.info?.sessionID === sessionId &&
                                            event.properties.info.finish === 'stop') {
                                            sseFinished = true;
                                            break;
                                        }
                                    }
                                } catch (e) {
                                    logDebug(config, 'SSE consumer error:', e.message);
                                }
                            })();

                            // 3. Send prompt after SSE is connected
                            // Wait a tick to let SSE connection establish
                            await new Promise(r => setTimeout(r, 50));
                            client.session.prompt(promptParams).catch(err => logDebug(config, 'Prompt error:', err.message));

                            // 4. Wait for SSE to complete, with idle timeout
                            // Only apply idle timeout after first delta received
                            let idleTimer = null;
                            const resetIdle = () => {
                                if (idleTimer) clearTimeout(idleTimer);
                                if (sseReceivedDelta) {
                                    // After data starts flowing, 10s silence = done
                                    idleTimer = setTimeout(() => {
                                        if (!sseFinished) {
                                            logDebug(config, 'SSE idle timeout', { sessionId, deltaChars: sseContent.length + sseReasoning.length });
                                            sseFinished = true;
                                            sseController.abort();
                                        }
                                    }, 10000);
                                }
                            };

                            // Patch sendDelta to reset idle timer
                            const originalSendDelta = sendDelta;
                            sendDelta = function(delta, isReasoning) {
                                resetIdle();
                                return originalSendDelta(delta, isReasoning);
                            };

                            const sseTimeout = new Promise(resolve => setTimeout(() => resolve('timeout'), config.REQUEST_TIMEOUT_MS));
                            const sseResult = await Promise.race([ssePromise.then(() => 'done'), sseTimeout]);
                            if (idleTimer) clearTimeout(idleTimer);

                            if (sseFinished || (sseReceivedDelta && sseResult === 'done')) {
                                collected = { content: sseContent, reasoning: sseReasoning };
                                logDebug(config, 'SSE completed', { sessionId, deltaChars: sseContent.length + sseReasoning.length });
                            } else {
                                // SSE didn't get data or timed out — abort and poll
                                sseController.abort();
                                logDebug(config, 'SSE fallback to polling', { sessionId, sseReceivedDelta, sseResult });
                                const { content, reasoning, error } = await pollForAssistantResponse(client, config, sessionId, config.REQUEST_TIMEOUT_MS);
                                collected = { content, reasoning, error };
                                // Send any content not already streamed via SSE
                                if (reasoning && reasoning.startsWith(sseReasoning)) {
                                    const rem = reasoning.slice(sseReasoning.length);
                                    if (rem) sendDelta(rem, true);
                                } else if (reasoning && !sseReasoning) {
                                    sendDelta(reasoning, true);
                                }
                                if (content && content.startsWith(sseContent)) {
                                    const rem = content.slice(sseContent.length);
                                    if (rem) sendDelta(rem, false);
                                } else if (content && !sseContent) {
                                    sendDelta(content, false);
                                }
                            }
                        } catch (e) {
                            logDebug(config, 'Stream error:', e.message);
                            collected = { __error: e };
                        }

                        // Handle errors
                        if (collected?.__error) {
                            sendDelta(`[Proxy Error] ${collected.__error.message || 'Unknown error'}`);
                        } else if (collected?.error && !collected.content && !collected.reasoning) {
                            sendDelta(`[Proxy Error] ${collected.error.name || 'MiMoError'}: ${collected.error.data?.message || collected.error.message || 'Unknown error'}`);
                        }

                        // If model only produced reasoning (no content), emit raw content/reasoning as content
                        // so the client gets a visible response.
                        if (!streamedContent && collected?.content) {
                            res.write(sseChunk(id, modelStr, { content: collected.content }));
                            streamedContent = collected.content;
                        }
                        if (!streamedContent && !streamedReasoning && collected?.reasoning) {
                            // Last resort: use reasoning as content
                            res.write(sseChunk(id, modelStr, { content: collected.reasoning }));
                            streamedContent = collected.reasoning;
                        }

                        if (insideReasoning) {
                            res.write(sseChunk(id, modelStr, { content: '\n</think>\n\n' }));
                        }

                        // Always re-parse tool calls from full text for accuracy
                        let parsedToolCalls = hasExternalTools
                            ? parseExternalToolCallsFromText(externalToolRegistry, rawStreamedReasoning, rawStreamedContent)
                            : [];

                        const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry, config);
                        if (validatedStreamedToolCalls.length > 0) {
                            const toolCallDeltas = validatedStreamedToolCalls.map((tc, index) => ({
                                index, id: tc.id, type: 'function',
                                function: { name: tc.function.name, arguments: tc.function.arguments }
                            }));
                            res.write(sseChunk(id, modelStr, { tool_calls: toolCallDeltas }));
                        }

                        if (keepaliveInterval) clearInterval(keepaliveInterval);

                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const totalTokens = promptTokens + completionTokens + reasoningTokens;
                        const finishReason = validatedStreamedToolCalls.length > 0 ? 'tool_calls' : 'stop';
                        res.write(sseChunk(id, modelStr, {}, finishReason));
                        res.write(`data: ${JSON.stringify({
                            id, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens + reasoningTokens, total_tokens: totalTokens, completion_tokens_details: { reasoning_tokens: reasoningTokens } }
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        // ─── Non-Streaming Response ───
                        // Use polling for non-streaming (SSE may conflict with shared client)
                        const promptStart = Date.now();
                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error(`Request timeout after ${config.REQUEST_TIMEOUT_MS}ms`)), config.REQUEST_TIMEOUT_MS);
                        });
                        await Promise.race([client.session.prompt(promptParams), timeoutPromise]);
                        logDebug(config, 'Prompt sent', { sessionId, ms: Date.now() - promptStart });

                        const { content, reasoning, error } = await pollForAssistantResponse(client, config, sessionId, config.REQUEST_TIMEOUT_MS);

                        if (error && !content && !reasoning) {
                            return res.status(502).json({ error: { message: error.data?.message || error.message || 'MiMo provider error', type: error.name || 'MiMoError' } });
                        }

                        // Parse tool calls
                        const parsedToolCalls = hasExternalTools
                            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
                            : [];
                        const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry, config);

                        const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content));
                        const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning));

                        const promptTokens = Math.ceil((fullPromptText || '').length / 4);
                        const completionTokensCalc = Math.ceil((safeContent || '').length / 4);
                        const reasoningTokensCalc = Math.ceil((safeReasoning || '').length / 4);
                        const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc;

                        // Don't mix reasoning into content — return pure content only.
                        // Reasoning is sent via stream deltas (with thinking tags) in streaming mode.
                        // Non-streaming returns clean content so title generation and other consumers
                        // don't pick up reasoning text.
                        // If content is empty but reasoning exists, use reasoning as content
                        // so the client always gets a visible response.
                        const finalContent = safeContent || (safeReasoning ? safeReasoning : '');

                        const publicToolCalls = toPublicToolCalls(validatedToolCalls);
                        const assistantMessage = publicToolCalls.length > 0
                            ? { role: 'assistant', content: finalContent || null, tool_calls: publicToolCalls }
                            : { role: 'assistant', content: finalContent };

                        res.json({
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: modelStr,
                            choices: [{ index: 0, message: assistantMessage, finish_reason: publicToolCalls.length > 0 ? 'tool_calls' : 'stop' }],
                            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokensCalc + reasoningTokensCalc, total_tokens: totalTokens, completion_tokens_details: { reasoning_tokens: reasoningTokensCalc } }
                        });
                    }
                } catch (error) {
                    console.error('[Proxy] API Error:', error.message);
                    if (keepaliveInterval) clearInterval(keepaliveInterval);

                    let errorMessage = error.message;
                    let statusCode = 500;
                    if (error.statusCode) statusCode = error.statusCode;
                    if (error.message?.includes('Request timeout')) statusCode = 504;

                    if (!res.headersSent) {
                        res.status(statusCode).json({ error: { message: errorMessage, type: error.code || error.constructor.name, ...(error.availableModels && { available_models: error.availableModels }) } });
                    } else if (!res.destroyed) {
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                    }
                } finally {
                    if (keepaliveInterval) clearInterval(keepaliveInterval);
                    if (sessionId) {
                        try {
                            await client.session.delete({ path: { id: sessionId } });
                            logDebug(config, 'Session deleted', { sessionId });
                        } catch (e) {
                            logDebug(config, 'Failed to delete session:', e.message);
                        }
                    }
                }
            }, config.REQUEST_TIMEOUT_MS + 20000);
        } catch (error) {
            console.error('[Proxy] Request Handler Error:', error.message);
            if (!res.headersSent) res.status(500).json({ error: { message: error.message, type: error.constructor.name } });
        }
    });

    return app;
}

// ─── Start Proxy ───
export async function startProxy(config) {
    const app = createApp(config);
    app.listen(config.PORT, config.BIND_HOST, () => {
        console.log(`[MiMoCode2API] Proxy server listening on http://${config.BIND_HOST}:${config.PORT}`);
        console.log(`[MiMoCode2API] Backend: ${config.MIMOCODE_SERVER_URL}`);
        console.log(`[MiMoCode2API] Manage backend: ${config.MANAGE_BACKEND}`);
        console.log(`[MiMoCode2API] Tools disabled: ${config.DISABLE_TOOLS}`);
        console.log(`[MiMoCode2API] API key: ${config.API_KEY ? 'enabled' : 'disabled'}`);
    });
}
