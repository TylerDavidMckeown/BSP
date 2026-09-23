import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

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
    const guildVoiceChannels = guild.channels.cache.filter(channel =>
      channel.isVoiceBased?.()
    ).size;
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
    },
    database: bot.db?.getStatus?.() ?? { connectionType: 'unknown', isDegraded: true },
    servers,
    history,
  };
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
      return res.status(401).json({ error: 'Invalid username or password' });
    }

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
    const username = verifySession(parseCookies(req.headers.cookie).dashboard_session);
    if (!username) return res.status(401).json({ error: 'Authentication required' });
    res.json(getStats(bot));
  });
}
