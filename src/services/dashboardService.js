import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import { loadCommands, registerCommands } from '../handlers/loaders/commandLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(__dirname, '../../dashboard');

const USERS = {
  TylerMck: () => process.env.TylerPassword,
  Izzy: () => process.env.IzzyPassword,
};

const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const HISTORY_LIMIT = 60;
const history = [];
const loginHistory = [];
const LOGIN_HISTORY_LIMIT = 100;
const startedAt = Date.now();

let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let eventLoopLagMs = 0;

const loopProbe = () => {
  const expected = Date.now() + 1000;
  setTimeout(() => {
    eventLoopLagMs = Math.max(0, Date.now() - expected);
    loopProbe();
  }, 1000).unref();
};
loopProbe();

function safeEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function issueSession(username) {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const secret = process.env.DASHBOARD_SESSION_SECRET || process.env.DISCORD_TOKEN;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const secret = process.env.DASHBOARD_SESSION_SECRET || process.env.DISCORD_TOKEN;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.username || !data.exp || data.exp < Date.now() || !USERS[data.username]?.()) return null;
    return data.username;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const i = part.indexOf('=');
    if (i < 0) return [part.trim(), ''];
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(([key]) => key));
}

function getStats(bot) {
  const guilds = [...bot.guilds.cache.values()];
  let members = 0;
  let bots = 0;
  let channels = 0;
  let voiceChannels = 0;
  let usersInVoice = 0;

  const servers = guilds.map(guild => {
    const memberCount = guild.memberCount ?? guild.members.cache.size;
    const guildBots = guild.members.cache.filter(member => member.user?.bot).size;
    const guildChannels = guild.channels.cache.size;
    const guildVoiceChannels = guild.channels.cache.filter(channel => channel.isVoiceBased?.()).size;
    const guildUsersInVoice = guild.members.cache.filter(member => member.voice?.channelId).size;

    members += memberCount;
    bots += guildBots;
    channels += guildChannels;
    voiceChannels += guildVoiceChannels;
    usersInVoice += guildUsersInVoice;

    return {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 64 }),
      members: memberCount,
      bots: guildBots,
      channels: guildChannels,
      voiceChannels: guildVoiceChannels,
      usersInVoice: guildUsersInVoice,
    };
  });

  const memory = process.memoryUsage();
  const nowHr = process.hrtime.bigint();
  const cpuNow = process.cpuUsage();
  const elapsedMicros = Number(nowHr - lastCpuAt) / 1000;
  const cpuMicros = (cpuNow.user - lastCpu.user) + (cpuNow.system - lastCpu.system);
  const cpuPercent = elapsedMicros > 0 ? Math.max(0, Math.min(100, (cpuMicros / elapsedMicros) * 100)) : 0;
  lastCpu = cpuNow;
  lastCpuAt = nowHr;

  const load = os.loadavg();
  // Discord bots do not have Minecraft TPS. This is an event-loop health metric,
  // expressed against the 20 ticks/sec reference (50ms per tick).
  const tps = Math.max(0, Math.min(20, 20 * (1 - Math.min(eventLoopLagMs, 50) / 50)));

  const snapshot = {
    timestamp: new Date().toISOString(),
    guilds: guilds.length,
    members,
    bots,
    humans: Math.max(0, members - bots),
    channels,
    voiceChannels,
    usersInVoice,
    uptimeSeconds: Math.floor(process.uptime()),
    websocketPing: bot.ws?.ping ?? null,
    memoryMb: Math.round(memory.rss / 1024 / 1024),
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    externalMb: Math.round(memory.external / 1024 / 1024),
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    load1m: Math.round(load[0] * 100) / 100,
    load5m: Math.round(load[1] * 100) / 100,
    load15m: Math.round(load[2] * 100) / 100,
    nodeVersion: process.version,
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    tps: Math.round(tps * 100) / 100,
    eventLoopLagMs: Math.round(eventLoopLagMs * 10) / 10,
    responseTimeMs: null,
  };

  history.push(snapshot);
  while (history.length > HISTORY_LIMIT) history.shift();

  return {
    ...snapshot,
    bot: {
      username: bot.user?.tag ?? 'Connecting…',
      id: bot.user?.id ?? null,
      status: bot.isReady() ? 'online' : 'starting',
      version: bot.config?.version ?? null,
      commandCount: bot.commands?.size ?? 0,
      prefix: process.env.COMMAND_PREFIX || 'Not configured',
      logLevel: process.env.LOG_LEVEL || 'info',
    },
    database: bot.db?.getStatus?.() ?? { connectionType: 'unknown', isDegraded: true },
    servers,
    history,
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: new Date(startedAt).toISOString(),
    },
  };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0].trim();
  return candidate || req.socket?.remoteAddress || 'unknown';
}

function recordLogin(username, req, success) {
  loginHistory.unshift({
    timestamp: new Date().toISOString(),
    username,
    ip: getClientIp(req),
    success,
    userAgent: String(req.headers['user-agent'] || 'unknown').slice(0, 300),
  });
  if (loginHistory.length > LOGIN_HISTORY_LIMIT) loginHistory.pop();
}

function dashboardUser(req) {
  return verifySession(parseCookies(req.headers.cookie).dashboard_session);
}

function requireDashboardUser(req, res) {
  const username = dashboardUser(req);
  if (!username) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return username;
}

async function control(bot, action) {
  if (action === 'restart') {
    setTimeout(() => process.exit(0), 250);
    return { message: 'Restart requested. The process will exit and the host can restart it.' };
  }

  if (action === 'stop') {
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 250);
    return { message: 'Stop requested.' };
  }

  if (action === 'cache') {
    bot.commands?.clear();
    bot.cooldowns?.clear();
    bot.buttons?.clear();
    bot.selectMenus?.clear();
    bot.modals?.clear();
    await loadCommands(bot);
    return { message: 'In-memory caches cleared and commands reloaded.' };
  }

  if (action === 'sync') {
    await registerCommands(bot, { clientId: bot.config.bot.clientId });
    return { message: 'Slash commands synchronized globally.' };
  }

  throw new Error('Unknown dashboard action');
}

export function startDashboard(bot, app) {
  const requiredPasswords = ['TylerPassword', 'IzzyPassword'];
  if (requiredPasswords.some(name => !process.env[name])) {
    throw new Error('Dashboard authentication requires TylerPassword and IzzyPassword environment variables.');
  }

  app.use('/dashboard', express.static(dashboardRoot, {
    index: 'index.html',
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));

  app.post('/api/dashboard/login', express.json(), (req, res) => {
    const { username, password } = req.body || {};
    const passwordProvider = USERS[username];
    if (!passwordProvider || !safeEqual(password, passwordProvider())) {
      recordLogin(username || 'unknown', req, false);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    recordLogin(username, req, true);
    const token = issueSession(username);
    sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `dashboard_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800${secure}`);
    res.json({ authenticated: true, username });
  });

  app.post('/api/dashboard/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.dashboard_session) sessions.delete(cookies.dashboard_session);
    res.setHeader('Set-Cookie', 'dashboard_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    res.json({ authenticated: false });
  });

  app.get('/api/dashboard/me', (req, res) => {
    const username = verifySession(parseCookies(req.headers.cookie).dashboard_session);
    if (!username) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, username });
  });

  app.get('/api/dashboard/stats', (req, res) => {
    if (!requireDashboardUser(req, res)) return;
    const started = process.hrtime.bigint();
    const stats = getStats(bot);
    stats.responseTimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    res.json(stats);
  });

  app.post('/api/dashboard/control/:action', express.json(), async (req, res) => {
    if (!requireDashboardUser(req, res)) return;
    try {
      res.json(await control(bot, req.params.action));
    } catch (error) {
      logger.error('Dashboard control failed:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/dashboard/config', (req, res) => {
    if (!requireDashboardUser(req, res)) return;
    res.json({
      prefix: process.env.COMMAND_PREFIX || 'Not configured',
      logLevel: process.env.LOG_LEVEL || 'info',
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT || bot.config?.api?.port || 3000,
    });
  });
}
