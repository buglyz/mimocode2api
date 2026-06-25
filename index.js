import { startProxy } from './src/proxy.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
        if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
    }
    if (value === undefined || value === null) return fallback;
    return Boolean(value);
}

// Default configuration
const defaultConfig = {
    PORT: parseInt(process.env.MIMOCODE_PROXY_PORT) || 10000,
    API_KEY: '',
    MIMOCODE_SERVER_URL: `http://127.0.0.1:${process.env.MIMOCODE_SERVER_PORT || 10001}`,
    MIMOCODE_SERVER_PASSWORD: process.env.MIMOCODE_SERVER_PASSWORD || '',
    MANAGE_BACKEND: parseBool(process.env.MIMOCODE_PROXY_MANAGE_BACKEND, false),
    MIMOCODE_PATH: process.env.MIMOCODE_PATH || 'mimo',
    BIND_HOST: '0.0.0.0',
    DISABLE_TOOLS: true,
    DEBUG: parseBool(process.env.MIMOCODE_PROXY_DEBUG, false),
    REQUEST_TIMEOUT_MS: parseInt(process.env.MIMOCODE_PROXY_REQUEST_TIMEOUT_MS) || 180000,
    PROMPT_MODE: process.env.MIMOCODE_PROXY_PROMPT_MODE || 'standard',
    OMIT_SYSTEM_PROMPT: parseBool(process.env.MIMOCODE_PROXY_OMIT_SYSTEM_PROMPT, false),
    AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env.MIMOCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS, false),
    CLEANUP_INTERVAL_MS: parseInt(process.env.MIMOCODE_PROXY_CLEANUP_INTERVAL_MS) || 43200000,
    CLEANUP_MAX_AGE_MS: parseInt(process.env.MIMOCODE_PROXY_CLEANUP_MAX_AGE_MS) || 86400000,
};

// Load config from file
const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};

if (fs.existsSync(configPath)) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        fileConfig = JSON.parse(content);
        console.log('[Config] Loaded from config.json');
    } catch (err) {
        console.error('[Config] Error parsing config.json:', err.message);
    }
}

// Merge configs: env > file > default
const finalConfig = {
    PORT: parseInt(process.env.MIMOCODE_PROXY_PORT) || parseInt(process.env.PORT) || fileConfig.PORT || defaultConfig.PORT,
    API_KEY: process.env.API_KEY || fileConfig.API_KEY || defaultConfig.API_KEY,
    MIMOCODE_SERVER_URL: process.env.MIMOCODE_SERVER_URL || fileConfig.MIMOCODE_SERVER_URL || defaultConfig.MIMOCODE_SERVER_URL,
    MIMOCODE_SERVER_PASSWORD: process.env.MIMOCODE_SERVER_PASSWORD || fileConfig.MIMOCODE_SERVER_PASSWORD || defaultConfig.MIMOCODE_SERVER_PASSWORD,
    MANAGE_BACKEND: parseBool(process.env.MIMOCODE_PROXY_MANAGE_BACKEND, fileConfig.MANAGE_BACKEND ?? defaultConfig.MANAGE_BACKEND),
    MIMOCODE_PATH: process.env.MIMOCODE_PATH || fileConfig.MIMOCODE_PATH || defaultConfig.MIMOCODE_PATH,
    BIND_HOST: process.env.BIND_HOST || fileConfig.BIND_HOST || defaultConfig.BIND_HOST,
    DISABLE_TOOLS: parseBool(process.env.DISABLE_TOOLS, fileConfig.DISABLE_TOOLS ?? defaultConfig.DISABLE_TOOLS),
    DEBUG: parseBool(process.env.MIMOCODE_PROXY_DEBUG, fileConfig.DEBUG ?? defaultConfig.DEBUG),
    REQUEST_TIMEOUT_MS: parseInt(process.env.MIMOCODE_PROXY_REQUEST_TIMEOUT_MS) || fileConfig.REQUEST_TIMEOUT_MS || defaultConfig.REQUEST_TIMEOUT_MS,
    PROMPT_MODE: process.env.MIMOCODE_PROXY_PROMPT_MODE || fileConfig.PROMPT_MODE || defaultConfig.PROMPT_MODE,
    OMIT_SYSTEM_PROMPT: parseBool(process.env.MIMOCODE_PROXY_OMIT_SYSTEM_PROMPT, fileConfig.OMIT_SYSTEM_PROMPT ?? defaultConfig.OMIT_SYSTEM_PROMPT),
    AUTO_CLEANUP_CONVERSATIONS: parseBool(process.env.MIMOCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS, fileConfig.AUTO_CLEANUP_CONVERSATIONS ?? defaultConfig.AUTO_CLEANUP_CONVERSATIONS),
    CLEANUP_INTERVAL_MS: parseInt(process.env.MIMOCODE_PROXY_CLEANUP_INTERVAL_MS) || fileConfig.CLEANUP_INTERVAL_MS || defaultConfig.CLEANUP_INTERVAL_MS,
    CLEANUP_MAX_AGE_MS: parseInt(process.env.MIMOCODE_PROXY_CLEANUP_MAX_AGE_MS) || fileConfig.CLEANUP_MAX_AGE_MS || defaultConfig.CLEANUP_MAX_AGE_MS,
};

startProxy(finalConfig);
