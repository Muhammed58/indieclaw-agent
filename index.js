#!/usr/bin/env node

const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');

// --- Version from package.json ---
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// --- Configuration ---
const PORT = parseInt(process.env.INDIECLAW_PORT || '3100', 10);
const TOKEN_FILE = path.join(os.homedir(), '.indieclaw-token');

// --- TLS Configuration ---
const TLS_ENABLED = process.env.INDIECLAW_TLS === '1';
const INDIECLAW_DIR = path.join(os.homedir(), '.indieclaw');
const DEFAULT_TLS_CERT = path.join(INDIECLAW_DIR, 'cert.pem');
const DEFAULT_TLS_KEY = path.join(INDIECLAW_DIR, 'key.pem');
const TLS_CERT_PATH = process.env.INDIECLAW_TLS_CERT || DEFAULT_TLS_CERT;
const TLS_KEY_PATH = process.env.INDIECLAW_TLS_KEY || DEFAULT_TLS_KEY;

// --- Push Notification Config ---
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const PUSH_TOKENS_FILE = path.join(INDIECLAW_DIR, 'push-tokens.json');

function getOrCreateToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch {
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
  }
}

const AUTH_TOKEN = process.env.INDIECLAW_TOKEN || getOrCreateToken();

// --- PTY setup (optional, graceful fallback) ---
let pty;
try {
  pty = require('node-pty');
} catch {
  console.log('[agent] node-pty not available — terminal feature disabled');
}

// --- TLS Setup ---
function ensureTlsCerts() {
  if (!fs.existsSync(INDIECLAW_DIR)) {
    fs.mkdirSync(INDIECLAW_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(TLS_CERT_PATH) || !fs.existsSync(TLS_KEY_PATH)) {
    console.log('[agent] Generating self-signed TLS certificate...');
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${TLS_KEY_PATH}" -out "${TLS_CERT_PATH}" -days 365 -nodes -subj "/CN=indieclaw-agent"`,
        { timeout: 15000, stdio: 'pipe' }
      );
      fs.chmodSync(TLS_KEY_PATH, 0o600);
      fs.chmodSync(TLS_CERT_PATH, 0o644);
      console.log('[agent] Self-signed certificate generated.');
    } catch (err) {
      console.error('[agent] Failed to generate TLS certificate:', err.message);
      process.exit(1);
    }
  }
}

// --- WebSocket Server ---
let wss;
let server;

if (TLS_ENABLED) {
  ensureTlsCerts();
  const tlsOptions = {
    cert: fs.readFileSync(TLS_CERT_PATH),
    key: fs.readFileSync(TLS_KEY_PATH),
  };
  server = https.createServer(tlsOptions);
  wss = new WebSocketServer({ server });
  server.listen(PORT);
} else {
  wss = new WebSocketServer({ port: PORT });
}

const terminals = new Map(); // id -> pty process
const activeChats = new Map(); // chatId -> { runId, _ws }
const activeSearches = new Map(); // ws -> child_process (one search per connection)

// --- Deep Link & QR Code ---
function getMachineIP() {
  // Try Tailscale first
  try {
    const tsIP = execSync('tailscale ip -4', { timeout: 3000, stdio: 'pipe' }).toString().trim();
    if (tsIP) return tsIP;
  } catch {}

  // Fallback to network interfaces
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const machineIP = getMachineIP();
const deepLink = `indieclaw://connect?host=${machineIP}&port=${PORT}&token=${AUTH_TOKEN}&name=${os.hostname()}&tls=${TLS_ENABLED ? '1' : '0'}`;

console.log('');
console.log('  ╔═══════════════════════════════════════╗');
console.log(`  ║       IndieClaw Agent v${VERSION.padEnd(16)}║`);
console.log('  ╠═══════════════════════════════════════╣');
console.log(`  ║  Port:  ${String(PORT).padEnd(30)}║`);
console.log(`  ║  Token: ${AUTH_TOKEN.substring(0, 12)}...              ║`);
console.log(`  ║  TLS:   ${TLS_ENABLED ? 'Enabled ' : 'Disabled'}                      ║`);
console.log('  ╚═══════════════════════════════════════╝');
console.log('');
console.log(`  Full token: ${AUTH_TOKEN}`);
console.log('  Enter this token in the IndieClaw mobile app to connect.');
console.log('');
console.log(`  Deep link: ${deepLink}`);
console.log('');

// Try to show QR code (optional dependency)
try {
  const qrcode = require('qrcode-terminal');
  qrcode.generate(deepLink, { small: true }, (qr) => {
    console.log('  Scan this QR code with your phone:');
    console.log('');
    qr.split('\n').forEach((line) => console.log('  ' + line));
    console.log('');
  });
} catch {
  // qrcode-terminal not installed, skip QR display
}

// --- OpenClaw Detection, Config & Gateway Client ---
const OPENCLAW_CONFIG_PATHS = [
  path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  path.join(os.homedir(), '.openclaw', 'openclaw.json5'),
];

function readOpenClawConfig() {
  for (const cfgPath of OPENCLAW_CONFIG_PATHS) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      let raw = fs.readFileSync(cfgPath, 'utf-8');
      raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      raw = raw.replace(/,\s*([\]}])/g, '$1');
      const config = JSON.parse(raw);
      const gw = config.gateway || {};
      return {
        port: gw.port || 18789,
        token: gw.auth?.token || gw.auth?.password || null,
        host: gw.bind || '127.0.0.1',
      };
    } catch {}
  }
  // Fallback: check env var
  return {
    port: parseInt(process.env.OPENCLAW_GATEWAY_PORT || '18789', 10),
    token: process.env.OPENCLAW_GATEWAY_TOKEN || null,
    host: '127.0.0.1',
  };
}

let openClawConfig = readOpenClawConfig();

// TCP port check — fast and reliable, no auth needed
function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

async function detectOpenClaw() {
  openClawConfig = readOpenClawConfig();
  const listening = await isPortListening(openClawConfig.port);
  if (listening) {
    return { available: true, models: ['openclaw'], port: openClawConfig.port };
  }
  // Fallback: check if config file exists (installed but not running)
  const installed = OPENCLAW_CONFIG_PATHS.some((p) => fs.existsSync(p));
  if (installed) {
    return { available: false, models: [], port: openClawConfig.port, installed: true };
  }
  return { available: false, models: [], port: null };
}

// --- OpenClaw Gateway WebSocket Client ---
let ocGateway = null;
let ocReady = false;
const ocPending = new Map();
const ocChatCallbacks = new Map(); // runId -> { ws, chatId }

function connectOcGateway() {
  return new Promise((resolve, reject) => {
    openClawConfig = readOpenClawConfig();
    const url = `ws://127.0.0.1:${openClawConfig.port}`;

    if (ocGateway) { try { ocGateway.close(); } catch {} }
    ocGateway = null;
    ocReady = false;

    const ws = new WebSocket(url);
    let connectReqId = null;
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Gateway timeout')); }, 10000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // Step 1: Gateway sends connect.challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        connectReqId = crypto.randomUUID();
        const params = {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'indieclaw-agent', version: VERSION, platform: os.platform(), mode: 'operator' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
        };
        if (openClawConfig.token) params.auth = { token: openClawConfig.token };
        ws.send(JSON.stringify({ type: 'req', id: connectReqId, method: 'connect', params }));
        return;
      }

      // Step 2: Handle hello-ok response
      if (msg.type === 'res' && msg.id === connectReqId) {
        clearTimeout(timeout);
        if (msg.ok) {
          ocGateway = ws;
          ocReady = true;
          resolve(ws);
        } else {
          ws.close();
          reject(new Error(msg.error?.message || 'Gateway auth failed'));
        }
        return;
      }

      // Handle other req/res
      if (msg.type === 'res' && msg.id) {
        const pending = ocPending.get(msg.id);
        if (pending) {
          ocPending.delete(msg.id);
          clearTimeout(pending.timeout);
          if (msg.ok) pending.resolve(msg.payload);
          else pending.reject(new Error(msg.error?.message || 'Request failed'));
        }
      }

      // Handle chat streaming events
      if (msg.type === 'event' && msg.event === 'chat') {
        const p = msg.payload;
        const cb = ocChatCallbacks.get(p.runId);
        if (!cb) return;

        if (p.state === 'delta') {
          // Extract text from delta — try common field paths
          const text = typeof p.message === 'string' ? p.message
            : p.message?.content || p.message?.text || '';
          if (text) send(cb.ws, { type: 'chat.stream', id: cb.chatId, content: text });
        } else if (p.state === 'final') {
          const text = typeof p.message === 'string' ? p.message
            : p.message?.content || p.message?.text || '';
          if (text) send(cb.ws, { type: 'chat.stream', id: cb.chatId, content: text });
          send(cb.ws, { type: 'chat.done', id: cb.chatId });
          ocChatCallbacks.delete(p.runId);
        } else if (p.state === 'error') {
          send(cb.ws, { type: 'chat.done', id: cb.chatId, error: p.errorMessage || 'OpenClaw error' });
          ocChatCallbacks.delete(p.runId);
        } else if (p.state === 'aborted') {
          send(cb.ws, { type: 'chat.done', id: cb.chatId });
          ocChatCallbacks.delete(p.runId);
        }
      }
    });

    ws.on('error', (err) => { clearTimeout(timeout); ocReady = false; reject(err); });
    ws.on('close', () => {
      ocReady = false;
      ocGateway = null;
      // Notify all pending chat streams that gateway disconnected
      for (const [runId, cb] of ocChatCallbacks) {
        send(cb.ws, { type: 'chat.done', id: cb.chatId, error: 'OpenClaw gateway disconnected' });
        ocChatCallbacks.delete(runId);
      }
      // Reject all pending requests
      for (const [id, p] of ocPending) {
        clearTimeout(p.timeout);
        p.reject(new Error('Gateway disconnected'));
        ocPending.delete(id);
      }
    });
  });
}

async function getOcGateway() {
  if (ocGateway && ocGateway.readyState === WebSocket.OPEN && ocReady) return ocGateway;
  return connectOcGateway();
}

function ocRequest(method, params) {
  return new Promise(async (resolve, reject) => {
    try {
      const ws = await getOcGateway();
      const id = crypto.randomUUID();
      const t = setTimeout(() => { ocPending.delete(id); reject(new Error('Timeout')); }, 30000);
      ocPending.set(id, { resolve, reject, timeout: t });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    } catch (err) { reject(err); }
  });
}

// Run detection on startup
detectOpenClaw().then((oc) => {
  if (oc.available) {
    console.log(`  [OpenClaw] Detected (gateway on port ${oc.port})`);
    // Pre-connect to gateway
    connectOcGateway().catch(() => {});
  } else if (oc.installed) {
    console.log(`  [OpenClaw] Installed but gateway not running (port ${oc.port})`);
  } else {
    console.log('  [OpenClaw] Not detected');
  }
});

// --- Push Notification Helpers ---
function loadPushTokens() {
  try {
    return JSON.parse(fs.readFileSync(PUSH_TOKENS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function savePushTokens(tokens) {
  if (!fs.existsSync(INDIECLAW_DIR)) {
    fs.mkdirSync(INDIECLAW_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PUSH_TOKENS_FILE, JSON.stringify(tokens), 'utf-8');
}

function sendPushNotification(title, body, data = {}) {
  const tokens = loadPushTokens();
  if (!tokens.length) return;
  const payload = JSON.stringify(tokens.map(to => ({ to, title, body, data, sound: 'default' })));
  const req = https.request(EXPO_PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

wss.on('connection', (ws) => {
  let authenticated = false;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    }

    // Auth check
    if (!authenticated) {
      if (msg.type === 'auth' && msg.token === AUTH_TOKEN) {
        authenticated = true;
        const openclaw = await detectOpenClaw();
        return ws.send(JSON.stringify({ type: 'auth', success: true, openclaw }));
      }
      if (msg.type === 'ping') {
        return ws.send(JSON.stringify({ type: 'pong' }));
      }
      return ws.send(JSON.stringify({ type: 'auth', success: false, error: 'Unauthorized' }));
    }

    // Handle ping
    if (msg.type === 'ping') {
      return ws.send(JSON.stringify({ type: 'pong' }));
    }

    // Route message
    handleMessage(ws, msg).catch((err) => {
      console.error('[handleMessage] Unhandled error:', err.message || err);
    });
  });

  ws.on('close', () => {
    // Clean up any terminals owned by this connection
    for (const [id, term] of terminals) {
      if (term._ws === ws) {
        term.kill();
        terminals.delete(id);
      }
    }
    // Clean up any active chat streams owned by this connection
    for (const [chatId, chat] of activeChats) {
      if (chat._ws === ws) {
        if (chat.runId) {
          ocRequest('chat.abort', { runId: chat.runId }).catch(() => {});
          ocChatCallbacks.delete(chat.runId);
        }
        activeChats.delete(chatId);
      }
    }
    // Kill any active search process for this connection
    const search = activeSearches.get(ws);
    if (search) {
      search.kill();
      activeSearches.delete(ws);
    }
  });
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function reply(ws, id, data) {
  send(ws, { type: 'result', id, success: true, data });
}

function replyError(ws, id, error) {
  send(ws, { type: 'result', id, success: false, error });
}

async function handleMessage(ws, msg) {
  const { type, id } = msg;

  try {
    switch (type) {
      case 'exec':
        return handleExec(ws, msg);
      case 'fs.list':
        return handleFsList(ws, msg);
      case 'fs.read':
        return handleFsRead(ws, msg);
      case 'fs.write':
        return handleFsWrite(ws, msg);
      case 'fs.delete':
        return handleFsDelete(ws, msg);
      case 'system.stats':
        return handleSystemStats(ws, msg);
      case 'system.top.cpu':
        return handleTopCpu(ws, msg);
      case 'system.top.memory':
        return handleTopMemory(ws, msg);
      case 'system.disk.details':
        return handleDiskDetails(ws, msg);
      case 'docker.list':
        return handleDockerList(ws, msg);
      case 'docker.logs':
        return handleDockerLogs(ws, msg);
      case 'docker.start':
        return handleDockerAction(ws, msg, 'start');
      case 'docker.stop':
        return handleDockerAction(ws, msg, 'stop');
      case 'docker.restart':
        return handleDockerAction(ws, msg, 'restart');
      case 'system.version':
        return handleSystemVersion(ws, msg);
      case 'system.update':
        return handleSystemUpdate(ws, msg);
      case 'cron.list':
        return handleCronList(ws, msg);
      case 'terminal.start':
        return handleTerminalStart(ws, msg);
      case 'terminal.input':
        return handleTerminalInput(ws, msg);
      case 'terminal.resize':
        return handleTerminalResize(ws, msg);
      case 'terminal.stop':
        return handleTerminalStop(ws, msg);
      case 'chat.send':
        return await handleChatSend(ws, msg);
      case 'chat.stop':
        return handleChatStop(ws, msg);
      case 'push.register':
        return handlePushRegister(ws, msg);
      case 'push.unregister':
        return handlePushUnregister(ws, msg);
      case 'logs.system':
        return handleLogsSystem(ws, msg);
      case 'logs.search':
        return handleLogsSearch(ws, msg);
      case 'cron.history':
        return handleCronHistory(ws, msg);
      case 'agent.list':
        return await handleAgentList(ws, msg);
      case 'agent.logs':
        return await handleAgentLogs(ws, msg);
      default:
        return replyError(ws, id, `Unknown message type: ${type}`);
    }
  } catch (err) {
    replyError(ws, id, err.message);
  }
}

// --- Command Execution ---
function handleExec(ws, { id, command }) {
  exec(command, { timeout: 30000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
    if (err && !stdout && !stderr) {
      return replyError(ws, id, err.message);
    }
    reply(ws, id, { stdout: stdout || '', stderr: stderr || '', exitCode: err ? err.code : 0 });
  });
}

// --- File System ---
function handleFsList(ws, { id, path: dirPath }) {
  const targetPath = dirPath || os.homedir();
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  const result = entries.map((entry) => {
    const fullPath = path.join(targetPath, entry.name);
    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch {
      stats = null;
    }
    return {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      size: stats ? stats.size : 0,
      modified: stats ? stats.mtime.toISOString() : null,
      permissions: stats ? '0' + (stats.mode & 0o777).toString(8) : null,
    };
  });
  reply(ws, id, result);
}

function handleFsRead(ws, { id, path: filePath }) {
  const content = fs.readFileSync(filePath, 'utf-8');
  reply(ws, id, { content, size: Buffer.byteLength(content) });
}

function handleFsWrite(ws, { id, path: filePath, content }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  reply(ws, id, { written: Buffer.byteLength(content) });
}

function handleFsDelete(ws, { id, path: filePath }) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true });
  } else {
    fs.unlinkSync(filePath);
  }
  reply(ws, id, { deleted: true });
}

// --- System Stats ---
function handleSystemStats(ws, { id }) {
  const platform = os.platform();
  const mem = platform === 'darwin' ? getDarwinMemory() : getLinuxMemory();
  const stats = {
    hostname: os.hostname(),
    platform,
    uptime: os.uptime(),
    loadAvg: os.loadavg(),
    cpu: {
      model: os.cpus()[0]?.model || 'Unknown',
      cores: os.cpus().length,
      usage: getCpuUsage(platform),
    },
    memory: mem,
    disk: getDiskUsage(platform),
  };
  reply(ws, id, stats);
}

function getDarwinMemory() {
  const total = os.totalmem();
  try {
    const out = execSync('vm_stat', { timeout: 3000 }).toString();
    const pageMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 16384;

    const val = (key) => {
      const m = out.match(new RegExp(key + ':\\s+(\\d+)'));
      return m ? parseInt(m[1], 10) : 0;
    };

    const wired = val('Pages wired down');
    const active = val('Pages active');
    const compressed = val('Pages occupied by compressor');
    const purgeable = val('Pages purgeable');

    // Used = wired + active (minus purgeable) + compressed — matches Activity Monitor
    const used = (wired + active - purgeable + compressed) * pageSize;
    const free = total - used;
    return {
      total,
      free: Math.max(free, 0),
      used: Math.min(used, total),
      usagePercent: Math.round((Math.min(used, total) / total) * 100),
    };
  } catch {
    // Fallback to Node.js (inaccurate on macOS but better than nothing)
    const free = os.freemem();
    return {
      total,
      free,
      used: total - free,
      usagePercent: Math.round(((total - free) / total) * 100),
    };
  }
}

function getLinuxMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
    used: total - free,
    usagePercent: Math.round(((total - free) / total) * 100),
  };
}

function getCpuUsage(platform) {
  try {
    if (platform === 'linux') {
      const load = os.loadavg()[0];
      const cores = os.cpus().length;
      return Math.min(Math.round((load / cores) * 100), 100);
    }
    if (platform === 'darwin') {
      const out = execSync("top -l 1 -n 0 | grep 'CPU usage'", { timeout: 5000 }).toString();
      const match = out.match(/([\d.]+)% idle/);
      if (match) return Math.round(100 - parseFloat(match[1]));
    }
    return Math.min(Math.round((os.loadavg()[0] / os.cpus().length) * 100), 100);
  } catch {
    return 0;
  }
}

function getDiskUsage(platform) {
  try {
    if (platform === 'darwin') {
      // macOS APFS: "Used" column only shows one volume's data
      // Calculate used = total - available for accurate results
      const out = execSync('df -k /', { timeout: 5000 }).toString();
      const lines = out.trim().split('\n').slice(1);
      return lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        // Columns: Filesystem 1K-blocks Used Available Capacity iused ifree %iused Mounted
        const total = parseInt(parts[1], 10) * 1024;
        const available = parseInt(parts[3], 10) * 1024;
        const used = total - available;
        return {
          filesystem: parts[0],
          mount: parts[8] || '/',
          total,
          used,
          available,
          usagePercent: Math.round((used / total) * 100),
        };
      });
    }
    // Linux
    const out = execSync('df -k / --output=source,size,used,avail,pcent,target', { timeout: 5000 }).toString();
    const lines = out.trim().split('\n').slice(1);
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        filesystem: parts[0],
        total: parseInt(parts[1], 10) * 1024,
        used: parseInt(parts[2], 10) * 1024,
        available: parseInt(parts[3], 10) * 1024,
        usagePercent: parseInt(parts[4], 10),
        mount: parts[5] || '/',
      };
    });
  } catch {
    return [];
  }
}

// --- Top Processes (CPU) ---
function handleTopCpu(ws, { id }) {
  const platform = os.platform();
  const cmd = platform === 'darwin'
    ? 'ps aux -r | head -11'
    : 'ps aux --sort=-%cpu | head -11';

  exec(cmd, { timeout: 5000 }, (err, stdout) => {
    if (err) return replyError(ws, id, err.message);
    const processes = parsePsOutput(stdout);
    reply(ws, id, { processes, timestamp: Date.now() });
  });
}

// --- Top Processes (Memory) ---
function handleTopMemory(ws, { id }) {
  const platform = os.platform();
  const cmd = platform === 'darwin'
    ? 'ps aux -m | head -11'
    : 'ps aux --sort=-%mem | head -11';

  exec(cmd, { timeout: 5000 }, (err, stdout) => {
    if (err) return replyError(ws, id, err.message);
    const processes = parsePsOutput(stdout);
    reply(ws, id, { processes, timestamp: Date.now() });
  });
}

function parsePsOutput(stdout) {
  const lines = stdout.trim().split('\n').slice(1); // skip header
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    return {
      pid: parseInt(parts[1], 10),
      name: parts.slice(10).join(' '),
      cpu: parseFloat(parts[2]) || 0,
      memory: parseFloat(parts[3]) || 0,
    };
  });
}

// --- Disk Details ---
function handleDiskDetails(ws, { id }) {
  const platform = os.platform();

  const virtualFs = new Set([
    'devtmpfs', 'tmpfs', 'sysfs', 'proc', 'devpts', 'securityfs',
    'cgroup', 'cgroup2', 'pstore', 'debugfs', 'hugetlbfs', 'mqueue',
    'configfs', 'fusectl', 'tracefs', 'bpf', 'overlay', 'nsfs',
    'autofs', 'binfmt_misc', 'efivarfs',
  ]);

  const cmd = 'df -kT';

  exec(cmd, { timeout: 5000 }, (err, stdout) => {
    if (err) {
      // Fallback: df -k without -T (macOS sometimes lacks -T)
      return exec('df -k', { timeout: 5000 }, (err2, stdout2) => {
        if (err2) return replyError(ws, id, err2.message);
        const partitions = parseDfOutput(stdout2, false, virtualFs);
        reply(ws, id, { partitions, timestamp: Date.now() });
      });
    }
    const partitions = parseDfOutput(stdout, true, virtualFs);
    reply(ws, id, { partitions, timestamp: Date.now() });
  });
}

function parseDfOutput(stdout, hasType, virtualFs) {
  const lines = stdout.trim().split('\n').slice(1);
  return lines
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (hasType) {
        // Filesystem Type 1K-blocks Used Available Use% Mounted
        const fsType = parts[1];
        if (virtualFs.has(fsType)) return null;
        return {
          filesystem: parts[0],
          type: fsType,
          total: parseInt(parts[2], 10) * 1024,
          used: parseInt(parts[3], 10) * 1024,
          available: parseInt(parts[4], 10) * 1024,
          usagePercent: parseInt(parts[5], 10) || 0,
          mount: parts.slice(6).join(' ') || '/',
        };
      }
      // Filesystem 1K-blocks Used Available Use% Mounted
      const fsName = parts[0];
      if (fsName === 'devfs' || fsName === 'map' || fsName.startsWith('map ')) return null;
      return {
        filesystem: fsName,
        type: 'unknown',
        total: parseInt(parts[1], 10) * 1024,
        used: parseInt(parts[2], 10) * 1024,
        available: parseInt(parts[3], 10) * 1024,
        usagePercent: parseInt(parts[4], 10) || 0,
        mount: parts.slice(5).join(' ') || '/',
      };
    })
    .filter(Boolean);
}

// --- Docker ---
function handleDockerList(ws, { id }) {
  exec(
    'docker ps -a --format "{{json .}}"',
    { timeout: 10000 },
    (err, stdout) => {
      if (err) return replyError(ws, id, 'Docker not available or not running');
      const containers = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const c = JSON.parse(line);
          return {
            id: c.ID,
            name: c.Names,
            image: c.Image,
            status: c.Status,
            state: c.State,
            ports: c.Ports,
            created: c.CreatedAt,
          };
        });
      reply(ws, id, containers);
    }
  );
}

function handleDockerLogs(ws, { id, containerId, lines = 100 }) {
  exec(
    `docker logs --tail ${lines} ${containerId}`,
    { timeout: 10000, maxBuffer: 1024 * 1024 * 5 },
    (err, stdout, stderr) => {
      if (err) return replyError(ws, id, err.message);
      reply(ws, id, { logs: stdout + stderr });
    }
  );
}

function handleDockerAction(ws, { id, containerId }, action) {
  exec(`docker ${action} ${containerId}`, { timeout: 30000 }, (err, stdout) => {
    if (err) return replyError(ws, id, err.message);
    reply(ws, id, { success: true, output: stdout.trim() });
  });
}

// --- Agent Version & Update ---
function handleSystemVersion(ws, { id }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  exec('npm view indieclaw-agent version', { timeout: 10000 }, (err, stdout) => {
    const latest = err ? null : stdout.trim();
    reply(ws, id, { current: pkg.version, latest });
  });
}

function handleSystemUpdate(ws, { id }) {
  const { spawn } = require('child_process');
  const platform = os.platform();

  // Resolve the full path to npm so detached scripts can find it
  let npmPath = 'npm';
  try {
    npmPath = execSync('which npm', { timeout: 3000 }).toString().trim();
  } catch {}

  let script;
  if (platform === 'win32') {
    script = `@echo off
timeout /t 2 /nobreak >nul
npm install -g indieclaw-agent@latest
start "" indieclaw-agent`;
  } else {
    script = `#!/bin/bash
exec > /tmp/indieclaw-update.log 2>&1
echo "[$(date)] Starting agent update..."
sleep 2
sudo ${npmPath} install -g indieclaw-agent@latest && sudo systemctl restart indieclaw-agent
echo "[$(date)] Done (exit code: $?)"`;
  }

  const ext = platform === 'win32' ? '.bat' : '.sh';
  const scriptPath = path.join(os.tmpdir(), `indieclaw-update${ext}`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  let child;
  if (platform === 'win32') {
    child = spawn('cmd', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true });
  } else if (platform === 'linux') {
    // systemd-run launches the script in a separate cgroup scope,
    // so it won't be killed when systemd restarts the agent service
    child = spawn('systemd-run', ['--scope', '--unit=indieclaw-update', 'bash', scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
  } else {
    child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' });
  }
  child.unref();

  reply(ws, id, { updating: true });

  // Give time for the reply to reach the client, then exit
  setTimeout(() => {
    for (const [, term] of terminals) term.kill();
    wss.close();
    process.exit(0);
  }, 500);
}

// --- Cron ---
function handleCronList(ws, { id }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown';
  exec('crontab -l', { timeout: 5000 }, (err, stdout) => {
    if (err) {
      if (err.message.includes('no crontab')) {
        return reply(ws, id, { timezone, jobs: [] });
      }
      return replyError(ws, id, err.message);
    }
    const jobs = stdout
      .trim()
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const schedule = parts.slice(0, 5).join(' ');
        const command = parts.slice(5).join(' ');
        return { schedule, command, raw: line.trim() };
      });
    reply(ws, id, { timezone, jobs });
  });
}

// --- Terminal (PTY with child_process fallback) ---
function handleTerminalStart(ws, { id }) {
  const shell = process.env.SHELL || '/bin/bash';

  // Try node-pty first
  if (pty) {
    try {
      const term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' },
      });

      term._ws = ws;
      term._isPty = true;
      terminals.set(id, term);

      term.onData((data) => {
        send(ws, { type: 'terminal.output', id, data });
      });

      term.onExit(({ exitCode }) => {
        send(ws, { type: 'terminal.exit', id, exitCode });
        terminals.delete(id);
      });

      return reply(ws, id, { pid: term.pid });
    } catch (err) {
      console.log(`[agent] node-pty spawn failed (${err.message}), using fallback`);
    }
  }

  const { spawn } = require('child_process');

  // macOS: use Python pty module (script(1) fails with piped stdin on macOS)
  if (os.platform() === 'darwin') {
    const pythonScript = `
import pty,os,sys,select,struct,fcntl,termios,signal
m,s=pty.openpty()
try:fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
except:pass
p=os.fork()
if p==0:
    os.close(m);os.setsid();fcntl.ioctl(s,termios.TIOCSCTTY,0)
    os.dup2(s,0);os.dup2(s,1);os.dup2(s,2)
    if s>2:os.close(s)
    sh=os.environ.get('SHELL','/bin/zsh')
    os.execvp(sh,[sh])
os.close(s);buf=b''
MK=b'\\x1b]9999;';EN=b'\\x07'
while True:
    try:r,_,_=select.select([m,0],[],[])
    except:break
    if m in r:
        try:d=os.read(m,16384)
        except OSError:break
        if not d:break
        try:os.write(1,d)
        except:break
    if 0 in r:
        try:d=os.read(0,4096)
        except OSError:break
        if not d:break
        buf+=d
        while MK in buf:
            i=buf.index(MK)
            if i>0:os.write(m,buf[:i]);buf=buf[i:]
            try:j=buf.index(EN)
            except ValueError:break
            c=buf[len(MK):j].decode().split(',')
            try:
                fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',int(c[1]),int(c[0]),0,0))
                os.kill(p,signal.SIGWINCH)
            except:pass
            buf=buf[j+1:]
        if buf and MK not in buf:os.write(m,buf);buf=b''
try:os.kill(p,signal.SIGTERM)
except:pass
try:os.waitpid(p,0)
except:pass
`;
    const proc = spawn('python3', ['-u', '-c', pythonScript], {
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc._ws = ws;
    proc._isPty = false;
    proc._hasPtyResize = true;

    proc.stdout.on('data', (data) => {
      send(ws, { type: 'terminal.output', id, data: data.toString() });
    });

    proc.stderr.on('data', (data) => {
      send(ws, { type: 'terminal.output', id, data: data.toString() });
    });

    proc.on('exit', (exitCode) => {
      send(ws, { type: 'terminal.exit', id, exitCode: exitCode ?? 0 });
      terminals.delete(id);
    });

    terminals.set(id, proc);
    return reply(ws, id, { pid: proc.pid });
  }

  // Linux: use script(1) to allocate a real PTY
  const scriptArgs = ['-q', '-c', shell, '/dev/null'];

  const proc = spawn('script', scriptArgs, {
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc._ws = ws;
  proc._isPty = false;

  proc.stdout.on('data', (data) => {
    send(ws, { type: 'terminal.output', id, data: data.toString() });
  });

  proc.stderr.on('data', (data) => {
    send(ws, { type: 'terminal.output', id, data: data.toString() });
  });

  proc.on('exit', (exitCode) => {
    send(ws, { type: 'terminal.exit', id, exitCode: exitCode ?? 0 });
    terminals.delete(id);
  });

  terminals.set(id, proc);
  reply(ws, id, { pid: proc.pid });
}

function handleTerminalInput(ws, { id, data }) {
  const term = terminals.get(id);
  if (!term) return replyError(ws, id, 'Terminal not found');
  if (term._isPty) {
    term.write(data);
  } else {
    term.stdin.write(data);
  }
}

function handleTerminalResize(ws, { id, cols, rows }) {
  const term = terminals.get(id);
  if (!term) return;
  if (term._isPty && term.resize) {
    term.resize(cols, rows);
  } else if (term._hasPtyResize) {
    // Python PTY: send resize via custom OSC escape sequence
    term.stdin.write(`\x1b]9999;${cols},${rows}\x07`);
  }
}

function handleTerminalStop(ws, { id }) {
  const term = terminals.get(id);
  if (!term) return replyError(ws, id, 'Terminal not found');
  term.kill();
  terminals.delete(id);
  reply(ws, id, { stopped: true });
}

// --- Chat (OpenClaw Gateway Proxy) ---
async function handleChatSend(ws, { id, messages }) {
  try {
    // Connect to OpenClaw gateway (auto-reconnects if needed)
    await getOcGateway();

    // Extract the last user message from the conversation
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return send(ws, { type: 'chat.done', id, error: 'No user message found' });
    }

    // Build a session key — unique per chat conversation
    const sessionKey = `agent:indieclaw:mobile:${id}`;
    const idempotencyKey = crypto.randomUUID();

    // Send chat request to gateway via WebSocket protocol
    const result = await ocRequest('chat.send', {
      sessionKey,
      message: { role: 'user', content: lastUserMsg.content },
      idempotencyKey,
    });

    // Register for streaming events using the runId from the response
    const runId = result?.runId || result?.id || id;
    ocChatCallbacks.set(runId, { ws, chatId: id });
    activeChats.set(id, { runId, _ws: ws });

  } catch (err) {
    send(ws, { type: 'chat.done', id, error: `OpenClaw: ${err.message}` });
  }
}

function handleChatStop(ws, { id, chatId }) {
  const chat = activeChats.get(chatId);
  if (chat && chat.runId) {
    // Abort the chat via OpenClaw gateway
    ocRequest('chat.abort', { runId: chat.runId }).catch(() => {});
    ocChatCallbacks.delete(chat.runId);
    activeChats.delete(chatId);
  }
  reply(ws, id, { stopped: true });
}

// --- Push Registration ---
function handlePushRegister(ws, { id, pushToken }) {
  const tokens = loadPushTokens();
  if (!tokens.includes(pushToken)) {
    tokens.push(pushToken);
    savePushTokens(tokens);
  }
  reply(ws, id, { registered: true });
}

function handlePushUnregister(ws, { id, pushToken }) {
  let tokens = loadPushTokens();
  tokens = tokens.filter((t) => t !== pushToken);
  savePushTokens(tokens);
  reply(ws, id, { unregistered: true });
}

// --- System Logs ---
function handleLogsSystem(ws, { id, lines = 200 }) {
  const platform = os.platform();

  if (platform === 'linux') {
    exec(`journalctl -n ${lines} --no-pager --since "1 hour ago" -o json`, { timeout: 10000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
      if (err) return replyError(ws, id, err.message);
      try {
        const entries = stdout.trim().split('\n').filter(Boolean).map((line) => {
          const j = JSON.parse(line);
          return {
            timestamp: j.__REALTIME_TIMESTAMP ? new Date(parseInt(j.__REALTIME_TIMESTAMP, 10) / 1000).toISOString() : null,
            level: j.PRIORITY || 'info',
            message: j.MESSAGE || '',
            source: j.SYSLOG_IDENTIFIER || j._COMM || '',
          };
        });
        reply(ws, id, entries);
      } catch (e) {
        replyError(ws, id, 'Failed to parse journal entries: ' + e.message);
      }
    });
  } else {
    // macOS
    exec(`log show --last 1h --style json | head -${lines}`, { timeout: 15000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (err) {
        // Fallback: try system.log
        return exec(`tail -${lines} /var/log/system.log`, { timeout: 5000 }, (err2, stdout2) => {
          if (err2) return replyError(ws, id, err2.message);
          const entries = stdout2.trim().split('\n').filter(Boolean).map((line) => ({
            timestamp: null,
            level: 'info',
            message: line,
            source: '',
          }));
          reply(ws, id, entries);
        });
      }
      try {
        const entries = stdout.trim().split('\n').filter(Boolean).map((line) => {
          try {
            const j = JSON.parse(line);
            return {
              timestamp: j.timestamp || null,
              level: j.messageType || 'info',
              message: j.eventMessage || '',
              source: j.senderImagePath || j.processImagePath || '',
            };
          } catch {
            return { timestamp: null, level: 'info', message: line, source: '' };
          }
        });
        reply(ws, id, entries);
      } catch (e) {
        replyError(ws, id, 'Failed to parse log entries: ' + e.message);
      }
    });
  }
}

// --- Log Search ---
function handleLogsSearch(ws, { id, query, lines = 100 }) {
  const platform = os.platform();
  // Sanitize query to prevent command injection
  const safeQuery = query.replace(/["`$\\!;']/g, '');

  if (!safeQuery || safeQuery.length < 2) {
    return reply(ws, id, []);
  }

  // Kill any previous search for this connection to prevent pile-up
  const prev = activeSearches.get(ws);
  if (prev) {
    prev.kill();
    activeSearches.delete(ws);
  }

  let cmd;
  if (platform === 'linux') {
    // --since "24h ago" limits search scope instead of grepping entire journal
    cmd = `journalctl -n ${lines} --no-pager --since "24 hours ago" -g "${safeQuery}"`;
  } else {
    cmd = `grep -i "${safeQuery}" /var/log/system.log | tail -${lines}`;
  }

  const child = exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 * 2 }, (err, stdout) => {
    activeSearches.delete(ws);
    if (err) {
      // journalctl returns exit code 1 when no matches found — not an error
      if (err.killed) return; // process was killed by a newer search
      return reply(ws, id, []);
    }
    const entries = stdout.trim().split('\n').filter(Boolean).map((line) => ({
      timestamp: null,
      level: 'info',
      message: line,
      source: '',
    }));
    reply(ws, id, entries);
  });

  activeSearches.set(ws, child);
}

// --- Cron History ---
function handleCronHistory(ws, { id }) {
  const platform = os.platform();

  if (platform === 'linux') {
    exec('journalctl -u cron -n 50 --no-pager -o json', { timeout: 10000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
      if (err) return replyError(ws, id, err.message);
      try {
        const entries = stdout.trim().split('\n').filter(Boolean).map((line) => {
          const j = JSON.parse(line);
          return {
            timestamp: j.__REALTIME_TIMESTAMP ? new Date(parseInt(j.__REALTIME_TIMESTAMP, 10) / 1000).toISOString() : null,
            command: j.MESSAGE || '',
            exitCode: null,
            output: j.MESSAGE || '',
          };
        });
        reply(ws, id, entries);
      } catch (e) {
        replyError(ws, id, 'Failed to parse cron history: ' + e.message);
      }
    });
  } else {
    // macOS
    exec('grep CRON /var/log/system.log | tail -50', { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // No cron entries or file not accessible
        return reply(ws, id, []);
      }
      const entries = stdout.trim().split('\n').filter(Boolean).map((line) => ({
        timestamp: null,
        command: line,
        exitCode: null,
        output: line,
      }));
      reply(ws, id, entries);
    });
  }
}

// --- Agent List (OpenClaw Models) ---
async function handleAgentList(ws, { id }) {
  try {
    const oc = await detectOpenClaw();
    if (oc.available) {
      const models = oc.models.map((modelId) => ({
        id: modelId,
        name: modelId,
        status: 'running',
        port: oc.port,
      }));
      return reply(ws, id, models);
    }
    reply(ws, id, []);
  } catch (err) {
    replyError(ws, id, 'OpenClaw detection failed: ' + (err.message || String(err)));
  }
}

// --- Agent Logs ---
function handleAgentLogs(ws, { id, lines = 200 }) {
  const platform = os.platform();

  if (platform === 'linux') {
    exec(`journalctl -u openclaw -n ${lines} --no-pager`, { timeout: 10000, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
      if (err) return replyError(ws, id, err.message);
      reply(ws, id, { logs: stdout || '' });
    });
  } else {
    // macOS / fallback: try common log locations
    const logLocations = [
      path.join(os.homedir(), '.openclaw', 'logs', 'openclaw.log'),
      path.join(os.homedir(), '.openclaw', 'openclaw.log'),
      '/var/log/openclaw.log',
    ];

    let found = false;
    for (const logPath of logLocations) {
      try {
        if (fs.existsSync(logPath)) {
          exec(`tail -${lines} "${logPath}"`, { timeout: 5000 }, (err, stdout) => {
            if (err) return reply(ws, id, { logs: '' });
            reply(ws, id, { logs: stdout || '' });
          });
          found = true;
          break;
        }
      } catch {}
    }

    if (!found) {
      reply(ws, id, { logs: '' });
    }
  }
}

// --- Graceful Shutdown ---
function gracefulShutdown() {
  for (const [, term] of terminals) term.kill();
  activeChats.clear();
  ocChatCallbacks.clear();
  if (ocGateway) { try { ocGateway.close(); } catch {} }
  wss.close();
  if (server) server.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  gracefulShutdown();
});

process.on('SIGTERM', () => {
  gracefulShutdown();
});
