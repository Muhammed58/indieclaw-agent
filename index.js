#!/usr/bin/env node

const { WebSocketServer } = require('ws');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// --- Configuration ---
const PORT = parseInt(process.env.INDIECLAW_PORT || '3100', 10);
const TOKEN_FILE = path.join(os.homedir(), '.indieclaw-token');

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

// --- WebSocket Server ---
const wss = new WebSocketServer({ port: PORT });
const terminals = new Map(); // id -> pty process

console.log('');
console.log('  ╔═══════════════════════════════════════╗');
console.log('  ║       IndieClaw Agent v1.0.0          ║');
console.log('  ╠═══════════════════════════════════════╣');
console.log(`  ║  Port:  ${PORT}                          ║`);
console.log(`  ║  Token: ${AUTH_TOKEN.substring(0, 12)}...              ║`);
console.log('  ╚═══════════════════════════════════════╝');
console.log('');
console.log(`  Full token: ${AUTH_TOKEN}`);
console.log('  Enter this token in the IndieClaw mobile app to connect.');
console.log('');

wss.on('connection', (ws) => {
  let authenticated = false;

  ws.on('message', (raw) => {
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
        return ws.send(JSON.stringify({ type: 'auth', success: true }));
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
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    // Clean up any terminals owned by this connection
    for (const [id, term] of terminals) {
      if (term._ws === ws) {
        term.kill();
        terminals.delete(id);
      }
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
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem(),
      usagePercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    },
    disk: getDiskUsage(platform),
  };
  reply(ws, id, stats);
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
    const cmd = platform === 'darwin' ? 'df -k /' : 'df -k / --output=source,size,used,avail,pcent,target';
    const out = execSync(cmd, { timeout: 5000 }).toString();
    const lines = out.trim().split('\n').slice(1);
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      if (platform === 'darwin') {
        // macOS df: Filesystem 512-blocks Used Available Capacity ...
        // df -k gives 1K-blocks
        return {
          filesystem: parts[0],
          mount: parts[8] || parts[5] || '/',
          total: parseInt(parts[1], 10) * 1024,
          used: parseInt(parts[2], 10) * 1024,
          available: parseInt(parts[3], 10) * 1024,
          usagePercent: parseInt(parts[4], 10),
        };
      }
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

// --- Cron ---
function handleCronList(ws, { id }) {
  exec('crontab -l', { timeout: 5000 }, (err, stdout) => {
    if (err) {
      if (err.message.includes('no crontab')) {
        return reply(ws, id, []);
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
    reply(ws, id, jobs);
  });
}

// --- Terminal (PTY) ---
function handleTerminalStart(ws, { id }) {
  if (!pty) {
    return replyError(ws, id, 'Terminal not available (node-pty not installed)');
  }

  const shell = process.env.SHELL || '/bin/bash';
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  term._ws = ws;
  terminals.set(id, term);

  term.onData((data) => {
    send(ws, { type: 'terminal.output', id, data });
  });

  term.onExit(({ exitCode }) => {
    send(ws, { type: 'terminal.exit', id, exitCode });
    terminals.delete(id);
  });

  reply(ws, id, { pid: term.pid });
}

function handleTerminalInput(ws, { id, data }) {
  const term = terminals.get(id);
  if (!term) return replyError(ws, id, 'Terminal not found');
  term.write(data);
}

function handleTerminalResize(ws, { id, cols, rows }) {
  const term = terminals.get(id);
  if (!term) return replyError(ws, id, 'Terminal not found');
  term.resize(cols, rows);
}

function handleTerminalStop(ws, { id }) {
  const term = terminals.get(id);
  if (!term) return replyError(ws, id, 'Terminal not found');
  term.kill();
  terminals.delete(id);
  reply(ws, id, { stopped: true });
}

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  for (const [, term] of terminals) term.kill();
  wss.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [, term] of terminals) term.kill();
  wss.close();
  process.exit(0);
});
