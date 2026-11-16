const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');

const APPLICATION_ID = '1543679166967193620';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=9&encoding=json';
const API_URL = 'https://discord.com/api/v9';
const DEFAULT_BUTTON_1 = 'Listen on YouTube Music';
const DEFAULT_BUTTON_2 = 'Visit BitChord';
const PROJECT_URL = 'https://github.com/dhyaan1902/BitChord-Electron';

let stateCallback = null;
let isAvailable = true;
let isConnected = false;
let isEnabled = true;
let currentUser = null;
let gatewayStatus = 'off'; // 'off' | 'connecting' | 'ready' | 'error'
let gatewayProblem = null;
let activeTransport = null; // 'ipc' | 'gateway' | null

let ipcSocket = null;
let gatewaySocket = null;
let heartbeatTimer = null;
let lastHeartbeatAck = 0;
let lastPresence = null;
let loginWindow = null;
let configPath = null;

function init(userDataPath, onStateChange) {
  stateCallback = onStateChange;
  configPath = path.join(userDataPath, 'discord.json');
  loadConfig();
  // Automatically try local Discord Desktop IPC on startup
  tryConnectIpc();
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof data.enabled === 'boolean') isEnabled = data.enabled;
      if (data.token && data.user) {
        currentUser = data.user;
        // Reconnect Gateway if token saved
        connectGateway(data.token);
      }
    }
  } catch (err) {
    console.warn('Failed to load Discord config:', err);
  }
}

function saveConfig(token, user) {
  try {
    const data = {
      enabled: isEnabled,
      token: token || null,
      user: user || null
    };
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save Discord config:', err);
  }
}

function getState() {
  return {
    available: isAvailable,
    connected: isConnected,
    enabled: isEnabled,
    user: currentUser,
    gateway: gatewayStatus,
    problem: gatewayProblem
  };
}

function broadcast() {
  if (stateCallback) {
    stateCallback(getState());
  }
}

// ---- Local Discord IPC Socket Protocol --------------------------------------

function getDiscordIpcPaths() {
  const paths = [];
  if (process.platform === 'win32') {
    for (let i = 0; i < 10; i++) {
      paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    }
  } else {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid ? process.getuid() : 1000}`;
    for (let i = 0; i < 10; i++) {
      paths.push(path.join(runtimeDir, `discord-ipc-${i}`));
      paths.push(path.join(runtimeDir, `app/com.discordapp.Discord/discord-ipc-${i}`));
      paths.push(path.join('/tmp', `discord-ipc-${i}`));
    }
  }
  return paths;
}

function encodeIpcPacket(op, data) {
  const jsonBuf = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(jsonBuf.length, 4);
  return Buffer.concat([header, jsonBuf]);
}

function tryConnectIpc() {
  if (isConnected && activeTransport === 'ipc') return Promise.resolve(true);

  return new Promise((resolve) => {
    const candidatePaths = getDiscordIpcPaths();
    let index = 0;

    function tryNext() {
      if (index >= candidatePaths.length) {
        resolve(false);
        return;
      }

      const socketPath = candidatePaths[index++];
      let client = null;

      try {
        client = net.createConnection(socketPath);
      } catch (e) {
        tryNext();
        return;
      }

      let connected = false;
      let buf = Buffer.alloc(0);

      client.on('connect', () => {
        connected = true;
        // Send HANDSHAKE (op 0)
        client.write(encodeIpcPacket(0, { v: 1, client_id: APPLICATION_ID }));
      });

      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0);
          const len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          const jsonStr = buf.slice(8, 8 + len).toString('utf8');
          buf = buf.slice(8 + len);

          try {
            const msg = JSON.parse(jsonStr);
            if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
              ipcSocket = client;
              activeTransport = 'ipc';
              isConnected = true;
              gatewayStatus = 'ready';
              gatewayProblem = null;
              if (msg.data && msg.data.user) {
                const u = msg.data.user;
                currentUser = {
                  id: u.id,
                  username: u.username,
                  name: u.global_name || u.username,
                  avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null
                };
              } else {
                currentUser = { name: 'Discord User', username: 'discord', avatarUrl: null };
              }
              broadcast();
              resolve(true);
              return;
            }
          } catch (err) {
            console.warn('Discord IPC parse error:', err);
          }
        }
      });

      client.on('error', () => {
        client.destroy();
        if (!connected) tryNext();
      });

      client.on('close', () => {
        if (ipcSocket === client) {
          ipcSocket = null;
          if (activeTransport === 'ipc') {
            activeTransport = null;
            isConnected = false;
            gatewayStatus = 'off';
            broadcast();
          }
        }
      });

      setTimeout(() => {
        if (!connected && !isConnected) {
          client.destroy();
          tryNext();
        }
      }, 300);
    }

    tryNext();
  });
}

function resolveVariables(template, track) {
  return template
    .replaceAll('{song_name}', track.title || '')
    .replaceAll('{artist_name}', track.artist || '')
    .replaceAll('{album_name}', track.album || '');
}

function sendIpcActivity(track, options) {
  if (!ipcSocket || ipcSocket.destroyed) return;
  const opts = options || {};
  let activity = null;

  if (track) {
    const now = Date.now();
    const rate = track.playbackRate > 0 ? track.playbackRate : 1;
    const start = Math.round(now - track.positionMs / rate);
    const end = Math.round(now + Math.max(0, track.durationMs - track.positionMs) / rate);
    const watchUrl = `https://music.youtube.com/watch?v=${track.videoId}`;

    const buttons = [];
    if (opts.button1Visible !== false) {
      buttons.push({ label: resolveVariables(opts.button1Text || DEFAULT_BUTTON_1, track), url: watchUrl });
    }
    if (opts.button2Visible !== false) {
      buttons.push({ label: resolveVariables(opts.button2Text || DEFAULT_BUTTON_2, track), url: PROJECT_URL });
    }

    const activityTypes = { playing: 0, listening: 2, watching: 3, competing: 5 };
    const actType = activityTypes[opts.activityType] ?? 2;

    activity = {
      type: actType,
      details: rate !== 1 ? `${track.title} [${rate.toFixed(2)}x]` : track.title,
      state: track.artist,
      timestamps: { start, end },
      assets: {
        large_image: track.artworkUrl || 'icon',
        large_text: track.album || track.title
      }
    };
    if (buttons.length > 0) {
      activity.buttons = buttons;
    }
  }

  const payload = {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity: activity
    },
    nonce: crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
  };

  try {
    ipcSocket.write(encodeIpcPacket(1, payload));
  } catch (e) {
    console.warn('Error writing to Discord IPC:', e);
  }
}

// ---- Discord Gateway WebSocket Protocol (Web / Fallback) -------------------

function connectGateway(token) {
  if (!token) return;
  if (gatewaySocket) {
    try { gatewaySocket.close(); } catch (e) {}
  }

  gatewayStatus = 'connecting';
  broadcast();

  try {
    const ws = new WebSocket(GATEWAY_URL);
    gatewaySocket = ws;

    ws.onopen = () => {
      gatewayProblem = null;
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { op, d, t } = payload;

        if (op === 10) { // HELLO
          const interval = d.heartbeat_interval;
          clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: null }));
            }
          }, interval);

          // Send IDENTIFY
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token: token,
              capabilities: 16381,
              properties: {
                os: process.platform === 'win32' ? 'Windows' : 'Linux',
                browser: 'Chrome',
                device: ''
              },
              presence: { status: 'online', since: 0, activities: [], afk: false }
            }
          }));
        } else if (op === 0 && t === 'READY') {
          activeTransport = 'gateway';
          isConnected = true;
          gatewayStatus = 'ready';
          gatewayProblem = null;
          if (d && d.user) {
            currentUser = {
              id: d.user.id,
              username: d.user.username,
              name: d.user.global_name || d.user.username,
              avatarUrl: d.user.avatar ? `https://cdn.discordapp.com/avatars/${d.user.id}/${d.user.avatar}.png` : null
            };
          }
          broadcast();
          if (lastPresence) {
            sendGatewayActivity(lastPresence.track, lastPresence.options);
          }
        }
      } catch (err) {
        console.warn('Discord Gateway frame error:', err);
      }
    };

    ws.onerror = (err) => {
      gatewayStatus = 'error';
      gatewayProblem = 'Discord Gateway connection error';
      broadcast();
    };

    ws.onclose = (event) => {
      clearInterval(heartbeatTimer);
      if (gatewaySocket === ws) {
        gatewaySocket = null;
        if (activeTransport === 'gateway') {
          activeTransport = null;
          isConnected = false;
          gatewayStatus = 'off';
          broadcast();
        }
      }
    };
  } catch (err) {
    gatewayStatus = 'error';
    gatewayProblem = err.message || 'Failed to start Gateway';
    broadcast();
  }
}

function sendGatewayActivity(track, options) {
  if (!gatewaySocket || gatewaySocket.readyState !== WebSocket.OPEN) return;
  const opts = options || {};
  let activities = [];

  if (track) {
    const now = Date.now();
    const rate = track.playbackRate > 0 ? track.playbackRate : 1;
    const start = Math.round(now - track.positionMs / rate);
    const end = Math.round(now + Math.max(0, track.durationMs - track.positionMs) / rate);
    const watchUrl = `https://music.youtube.com/watch?v=${track.videoId}`;

    const buttons = [];
    if (opts.button1Visible !== false) {
      buttons.push(resolveVariables(opts.button1Text || DEFAULT_BUTTON_1, track));
    }
    if (opts.button2Visible !== false) {
      buttons.push(resolveVariables(opts.button2Text || DEFAULT_BUTTON_2, track));
    }

    const activityTypes = { playing: 0, listening: 2, watching: 3, competing: 5 };
    const actType = activityTypes[opts.activityType] ?? 2;

    activities.push({
      name: opts.activityName?.trim() || 'BitChord',
      type: actType,
      details: rate !== 1 ? `${track.title} [${rate.toFixed(2)}x]` : track.title,
      state: track.artist,
      timestamps: { start, end },
      assets: {
        large_image: track.artworkUrl || null,
        large_text: track.album || track.title
      },
      buttons: buttons,
      metadata: {
        button_urls: [watchUrl, PROJECT_URL]
      },
      application_id: APPLICATION_ID
    });
  }

  gatewaySocket.send(JSON.stringify({
    op: 3,
    d: {
      activities: activities,
      afk: true,
      since: Date.now(),
      status: opts.status || 'online'
    }
  }));
}

// ---- Public Control Methods -------------------------------------------------

async function connect(parentWindow) {
  // 1. Try local Discord Desktop IPC first (zero login needed!)
  const ipcOk = await tryConnectIpc();
  if (ipcOk) {
    return getState();
  }

  // 2. Fall back to Discord Web login modal
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return getState();
  }

  return new Promise((resolve) => {
    loginWindow = new BrowserWindow({
      width: 580,
      height: 720,
      parent: parentWindow,
      modal: true,
      title: 'Connect Discord - BitChord',
      autoHideMenuBar: true,
      backgroundColor: '#313338',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false
      }
    });

    loginWindow.setMenu(null);
    loginWindow.loadURL('https://discord.com/login');

    const checkToken = async () => {
      if (!loginWindow || loginWindow.isDestroyed()) return;
      try {
        const token = await loginWindow.webContents.executeJavaScript(`
          (() => {
            try {
              const frame = document.createElement('iframe');
              frame.style.display = 'none';
              document.body.appendChild(frame);
              const raw = frame.contentWindow?.localStorage.getItem('token') ?? null;
              frame.remove();
              return raw ? raw.slice(1, -1) : '';
            } catch {
              return '';
            }
          })()
        `);

        if (token && token.length > 20) {
          // Verify token and fetch profile
          const res = await fetch(`${API_URL}/users/@me`, {
            headers: { Authorization: token }
          });
          if (res.ok) {
            const me = await res.json();
            const user = {
              id: me.id,
              username: me.username,
              name: me.global_name || me.username,
              avatarUrl: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : null
            };
            currentUser = user;
            saveConfig(token, user);
            connectGateway(token);
            if (loginWindow && !loginWindow.isDestroyed()) {
              loginWindow.close();
              loginWindow = null;
            }
            resolve(getState());
          }
        }
      } catch (e) {
        // Continue polling
      }
    };

    const pollTimer = setInterval(checkToken, 1500);

    loginWindow.on('closed', () => {
      clearInterval(pollTimer);
      loginWindow = null;
      resolve(getState());
    });
  });
}

function disconnect() {
  if (ipcSocket) {
    try { ipcSocket.destroy(); } catch (e) {}
    ipcSocket = null;
  }
  if (gatewaySocket) {
    try { gatewaySocket.close(); } catch (e) {}
    gatewaySocket = null;
  }
  clearInterval(heartbeatTimer);
  activeTransport = null;
  isConnected = false;
  currentUser = null;
  gatewayStatus = 'off';
  gatewayProblem = null;
  saveConfig(null, null);
  broadcast();
  return getState();
}

function setEnabled(enabled) {
  isEnabled = !!enabled;
  if (!isEnabled) {
    setPresence(null, {});
  } else if (lastPresence) {
    setPresence(lastPresence.track, lastPresence.options);
  }
  saveConfig(null, currentUser);
  broadcast();
  return getState();
}

function setPresence(track, options) {
  lastPresence = { track, options };
  if (!isEnabled || !isConnected) return;

  if (activeTransport === 'ipc') {
    sendIpcActivity(track, options);
  } else if (activeTransport === 'gateway') {
    sendGatewayActivity(track, options);
  }
}

module.exports = {
  init,
  getState,
  connect,
  disconnect,
  setEnabled,
  setPresence
};
