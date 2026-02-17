#!/usr/bin/env node

const { WebSocketServer } = require('ws');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

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
const activeChats = new Map(); // id -> http.ClientRequest

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
    // Clean up any active chat streams owned by this connection
    for (const [id, req] of activeChats) {
      if (req._ws === ws) {
        req.destroy();
        activeChats.delete(id);
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
        return handleChatSend(ws, msg);
      case 'chat.stop':
        return handleChatStop(ws, msg);
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

// --- Chat (OpenClaw Proxy) ---
function handleChatSend(ws, { id, messages, openclawToken, openclawPort, openclawHost }) {
  const port = openclawPort || 18789;
  const host = openclawHost || '127.0.0.1';

  const body = JSON.stringify({
    model: 'openclaw:main',
    messages,
    stream: true,
  });

  const req = http.request(
    {
      hostname: host,
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openclawToken}`,
        'x-openclaw-agent-id': 'main',
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        let errorBody = '';
        res.on('data', (chunk) => (errorBody += chunk));
        res.on('end', () => {
          send(ws, { type: 'chat.done', id, error: `OpenClaw error ${res.statusCode}: ${errorBody}` });
          activeChats.delete(id);
        });
        return;
      }

      let buffer = '';
      let sentDone = false;

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') {
            if (!sentDone) {
              sentDone = true;
              send(ws, { type: 'chat.done', id });
              activeChats.delete(id);
            }
            return;
          }
          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                send(ws, { type: 'chat.stream', id, content });
              }
            } catch {}
          }
        }
      });

      res.on('end', () => {
        if (!sentDone) {
          sentDone = true;
          send(ws, { type: 'chat.done', id });
          activeChats.delete(id);
        }
      });

      res.on('error', (err) => {
        if (!sentDone) {
          sentDone = true;
          send(ws, { type: 'chat.done', id, error: err.message });
          activeChats.delete(id);
        }
      });
    }
  );

  req.on('error', (err) => {
    send(ws, { type: 'chat.done', id, error: `Connection failed: ${err.message}` });
    activeChats.delete(id);
  });

  req._ws = ws;
  activeChats.set(id, req);
  req.write(body);
  req.end();
}

function handleChatStop(ws, { id, chatId }) {
  const req = activeChats.get(chatId);
  if (req) {
    req.destroy();
    activeChats.delete(chatId);
  }
  reply(ws, id, { stopped: true });
}

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
  console.log('\n[agent] Shutting down...');
  for (const [, term] of terminals) term.kill();
  for (const [, req] of activeChats) req.destroy();
  wss.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const [, term] of terminals) term.kill();
  for (const [, req] of activeChats) req.destroy();
  wss.close();
  process.exit(0);
});
