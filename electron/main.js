const { app, BrowserWindow, Menu, session, ipcMain, shell, Tray, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const discord = require('./discord');

// Suppress security warnings in console
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Hardware acceleration & GPU rendering optimizations
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('gpu-rasterization-msaa-sample-count', '0');

// Buttery smooth frame pacing & kinetic scrolling
app.commandLine.appendSwitch(
  'enable-features',
  'CanvasOopRasterization,VaapiVideoDecoder,VaapiIgnoreDriverChecks,SmoothScrolling,ParallelDownloading,OverlayScrollbar' +
    (process.platform === 'linux' ? ',WaylandWindowDecorations' : '')
);
app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');

// Auto-detect Wayland on Linux (solves blurry scaling and eliminates XWayland overhead)
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('use-gl', 'egl');
}

// Memory & performance tuning (aggressive V8 garbage collection to minimize RAM usage)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256 --optimize-for-size --expose-gc');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const DEFAULT_ZOOM = 1.15; // 115% default provides a comfortable, readable desktop scale

function getPrefsFilePath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadSavedZoom() {
  try {
    const prefsPath = getPrefsFilePath();
    if (fs.existsSync(prefsPath)) {
      const data = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (typeof data.zoomFactor === 'number' && data.zoomFactor >= 0.5 && data.zoomFactor <= 3.0) {
        return data.zoomFactor;
      }
    }
  } catch (e) {}
  return DEFAULT_ZOOM;
}

function saveZoom(zoom) {
  try {
    const prefsPath = getPrefsFilePath();
    let data = {};
    if (fs.existsSync(prefsPath)) {
      try { data = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch (e) {}
    }
    data.zoomFactor = Math.round(zoom * 100) / 100;
    fs.writeFileSync(prefsPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

function adjustZoom(delta) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getZoomFactor();
  const next = Math.max(0.7, Math.min(2.0, Math.round((current + delta) * 100) / 100));
  mainWindow.webContents.setZoomFactor(next);
  saveZoom(next);
}

function resetZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomFactor(DEFAULT_ZOOM);
  saveZoom(DEFAULT_ZOOM);
}

// MIME types for the local static SPA server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm'
};

function startServer(appDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURI(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') {
        reqPath = '/index.html';
      }

      let filePath = path.join(appDir, reqPath);

      // Prevent directory traversal
      if (!filePath.startsWith(appDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          // SPA routing: for non-static files, fallback to index.html
          const ext = path.extname(reqPath);
          if (!ext || ext === '.html') {
            filePath = path.join(appDir, 'index.html');
          } else {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
          'Access-Control-Allow-Origin': '*'
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
      });
    });

    // Listen on 5173 first (BitChord trusted origin), fallback to random port
    server.listen(5173, '127.0.0.1', () => {
      resolve({ server, port: 5173 });
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1', () => {
          resolve({ server, port: server.address().port });
        });
      } else {
        reject(err);
      }
    });
  });
}

// Helper to compute SAPISIDHASH for YouTube Music requests
function getSapisidHash(secret, origin = 'https://music.youtube.com') {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHash('sha1').update(`${timestamp} ${secret} ${origin}`).digest('hex');
  return `SAPISIDHASH ${timestamp}_${digest}`;
}

// Renderers parser helper for YouTube responses
function findRenderers(root, key, out = []) {
  if (Array.isArray(root)) {
    for (const item of root) findRenderers(item, key, out);
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root)) {
      if (k === key && v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v);
      } else {
        findRenderers(v, key, out);
      }
    }
  }
  return out;
}

function getText(node) {
  if (!node) return '';
  if (node.runs && Array.isArray(node.runs)) {
    return node.runs.map(r => r.text || '').join('');
  }
  return node.simpleText || '';
}

function getPhoto(item) {
  if (!item || !item.accountPhoto) return null;
  const thumbnails = item.accountPhoto.thumbnails;
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    return thumbnails[thumbnails.length - 1].url || null;
  }
  return null;
}

let cachedAuthState = null;
let lastAuthCheck = 0;
let userConnectedPref = true;
let selectedChannelPref = null;

// Read dynamic extension version from packaged manifest
let extensionVersion = '0.4.4';
try {
  const manifestPath = path.join(__dirname, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version) {
      extensionVersion = manifest.version;
    }
  }
} catch (e) {
  // Use fallback version
}

async function getYouTubeAuthState(refresh = false) {
  if (!refresh && cachedAuthState && (Date.now() - lastAuthCheck < 60000)) {
    return cachedAuthState;
  }

  const [urlCookies, ytCookies] = await Promise.all([
    session.defaultSession.cookies.get({ url: 'https://music.youtube.com' }).catch(() => []),
    session.defaultSession.cookies.get({ domain: '.youtube.com' }).catch(() => [])
  ]);

  const cookieMap = new Map();
  for (const c of ytCookies) if (c.name && c.value) cookieMap.set(c.name, c.value);
  for (const c of urlCookies) if (c.name && c.value) cookieMap.set(c.name, c.value);
  const cookieList = Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value }));

  let sapisid = null;
  for (const name of ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']) {
    const c = cookieList.find(x => x.name === name);
    if (c) {
      sapisid = c.value;
      break;
    }
  }

  if (!sapisid) {
    cachedAuthState = {
      browserSignedIn: false,
      connected: false,
      signedIn: false,
      accounts: [],
      active: null,
      problem: null
    };
    lastAuthCheck = Date.now();
    return cachedAuthState;
  }

  if (!userConnectedPref) {
    cachedAuthState = {
      browserSignedIn: true,
      connected: false,
      signedIn: false,
      accounts: [],
      active: null,
      problem: null
    };
    lastAuthCheck = Date.now();
    return cachedAuthState;
  }

  const cookieString = cookieList.map(c => `${c.name}=${c.value}`).join('; ');
  const userAgent = session.defaultSession.getUserAgent();

  try {
    const hash = getSapisidHash(sapisid, 'https://music.youtube.com');
    const res = await fetch('https://music.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': hash,
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        'X-Origin': 'https://music.youtube.com',
        'X-Goog-AuthUser': '0',
        'X-Youtube-Client-Name': '67',
        'X-Youtube-Client-Version': '1.20251006.03.00',
        'User-Agent': userAgent,
        'Cookie': cookieString
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB_REMIX', clientVersion: '1.20251006.03.00', hl: 'en', gl: 'US' },
          user: {}
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`account_menu HTTP ${res.status}: ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    const headers = findRenderers(data, 'activeAccountHeaderRenderer');
    const header = headers[0];

    const name = header ? (getText(header.accountName) || 'YouTube Music') : 'YouTube Music';
    const email = header ? (getText(header.email) || null) : null;
    const handle = header ? (getText(header.channelHandle) || null) : null;
    const avatarUrl = header ? getPhoto(header) : null;

    let channels = [];
    try {
      const switcherRes = await fetch('https://music.youtube.com/youtubei/v1/account/accounts_list?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': hash,
          'Origin': 'https://music.youtube.com',
          'Referer': 'https://music.youtube.com/',
          'X-Origin': 'https://music.youtube.com',
          'X-Goog-AuthUser': '0',
          'X-Youtube-Client-Name': '67',
          'X-Youtube-Client-Version': '1.20251006.03.00',
          'User-Agent': userAgent,
          'Cookie': cookieString
        },
        body: JSON.stringify({
          context: {
            client: { clientName: 'WEB_REMIX', clientVersion: '1.20251006.03.00', hl: 'en', gl: 'US' },
            user: {}
          }
        })
      });

      if (switcherRes.ok) {
        const switcherData = await switcherRes.json();
        const items = findRenderers(switcherData, 'accountItem');
        for (const item of items) {
          const itemText = getText(item.accountName);
          if (itemText) {
            channels.push({
              id: item.pageId ? `0:${item.pageId}` : '0:own',
              name: itemText,
              handle: getText(item.channelHandle) || getText(item.accountByline) || null,
              avatarUrl: getPhoto(item),
              brand: !!item.pageId
            });
          }
        }
      }
    } catch (e) {
      // Ignore channel switcher errors
    }

    if (channels.length === 0) {
      channels.push({
        id: '0:own',
        name: name,
        handle: handle || email,
        avatarUrl: avatarUrl,
        brand: false
      });
    }

    const activeChannel = channels.find(c => c.id === selectedChannelPref) || channels[0];

    cachedAuthState = {
      browserSignedIn: true,
      connected: true,
      signedIn: true,
      accounts: [{
        authUser: '0',
        name: name,
        email: email,
        avatarUrl: avatarUrl,
        channels: channels
      }],
      active: {
        id: activeChannel.id,
        name: activeChannel.name,
        handle: activeChannel.handle,
        avatarUrl: activeChannel.avatarUrl,
        brand: activeChannel.brand,
        authUser: '0'
      },
      problem: null
    };
    lastAuthCheck = Date.now();
    return cachedAuthState;
  } catch (err) {
    console.warn('Error fetching YouTube account:', err);
    cachedAuthState = {
      browserSignedIn: true,
      connected: true,
      signedIn: false,
      accounts: [],
      active: null,
      problem: err.message || 'Failed to read YouTube Music account'
    };
    lastAuthCheck = Date.now();
    return cachedAuthState;
  }
}

let mainWindow = null;
let localServer = null;
let loginWindow = null;
let tray = null;
let isQuitting = false;

function createTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, 'icon.png');
  let icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  if (icon) {
    icon = icon.resize({ width: 22, height: 22 });
  }

  try {
    tray = new Tray(icon || iconPath);
    tray.setToolTip('BitChord');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show BitChord',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Hide to Tray',
        click: () => {
          if (mainWindow) {
            mainWindow.hide();
          }
        }
      },
      {
        label: 'Zoom',
        submenu: [
          { label: 'Zoom In (Ctrl + +)', click: () => adjustZoom(0.05) },
          { label: 'Zoom Out (Ctrl + -)', click: () => adjustZoom(-0.05) },
          { label: 'Reset Zoom (Ctrl + 0)', click: () => resetZoom() }
        ]
      },
      { type: 'separator' },
      {
        label: 'Quit BitChord',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (err) {
    console.warn('Could not initialize system tray:', err);
  }
}

function openLoginWindow(url) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 600,
    height: 750,
    parent: mainWindow,
    modal: true,
    title: 'Sign In to YouTube Music - BitChord',
    autoHideMenuBar: true,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: false
    }
  });

  loginWindow.setMenu(null);
  loginWindow.loadURL(url);

  loginWindow.webContents.on('did-navigate', async (event, newUrl) => {
    // When Google finishes auth and redirects to music.youtube.com, sign-in is complete!
    if (newUrl.startsWith('https://music.youtube.com') || newUrl.startsWith('https://www.youtube.com')) {
      await session.defaultSession.cookies.flushStore();
      cachedAuthState = null;
      setTimeout(() => {
        if (loginWindow && !loginWindow.isDestroyed()) {
          loginWindow.close();
          loginWindow = null;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      }, 1000);
    }
  });

  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// Register IPC handlers for bridge communication
ipcMain.handle('get-extension-info', () => {
  return {
    version: extensionVersion,
    protocol: 1,
    browser: 'chromium',
    capabilities: ['yt', 'yt.auth', 'yt.stats', 'addon', 'lyrics', 'spotify', 'discord']
  };
});

ipcMain.handle('get-yt-auth-state', async (event, refresh) => {
  return await getYouTubeAuthState(refresh);
});

ipcMain.handle('yt-select-channel', async (event, channelId) => {
  selectedChannelPref = channelId;
  return await getYouTubeAuthState(true);
});

ipcMain.handle('yt-set-connected', async (event, connected) => {
  userConnectedPref = connected;
  return await getYouTubeAuthState(true);
});

// Register Discord IPC handlers
ipcMain.handle('discord-state', () => {
  return discord.getState();
});

ipcMain.handle('discord-connect', async () => {
  return await discord.connect(mainWindow);
});

ipcMain.handle('discord-disconnect', () => {
  return discord.disconnect();
});

ipcMain.handle('discord-set-enabled', (event, on) => {
  return discord.setEnabled(on);
});

ipcMain.handle('discord-presence', (event, params) => {
  discord.setPresence(params && params.track, params && params.options);
  return {};
});

// Zoom IPC handlers
ipcMain.on('zoom-in', () => adjustZoom(0.05));
ipcMain.on('zoom-out', () => adjustZoom(-0.05));
ipcMain.on('zoom-reset', () => resetZoom());

const STATS_URL_PATTERN = /^https:\/\/(s|music|www)\.youtube\.com\/api\/stats\/(playback|watchtime|atr)(\?|$)/;
const IDENTITY_HEADERS = ['authorization', 'cookie', 'x-goog-authuser', 'x-goog-pageid', 'x-origin', 'origin', 'referer'];

async function serializeFetchResponse(res, reqUrl) {
  const resHeaders = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });
  const contentType = res.headers.get('content-type') || '';
  const textual = /json|text|javascript|xml/.test(contentType);
  let body;
  let bodyEncoding = 'text';
  if (textual) {
    body = await res.text();
  } else {
    const arrayBuffer = await res.arrayBuffer();
    body = Buffer.from(arrayBuffer).toString('base64');
    bodyEncoding = 'base64';
  }
  return {
    status: res.status,
    headers: resHeaders,
    body,
    bodyEncoding,
    url: res.url || reqUrl
  };
}

ipcMain.handle('yt-fetch', async (event, request) => {
  const method = (request.method || 'GET').toUpperCase();
  const reqUrl = request.url;

  // Handle anonymous yt.fetch (e.g. BotGuard GenerateIT at www.youtube.com/api/jnn/)
  if (!request.auth) {
    const cleanHeaders = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (!IDENTITY_HEADERS.includes(key.toLowerCase())) {
        cleanHeaders[key] = value;
      }
    }
    cleanHeaders['User-Agent'] = session.defaultSession.getUserAgent();

    let body = request.body;
    if (body !== undefined && request.bodyEncoding === 'base64') {
      body = Buffer.from(body, 'base64');
    }

    const options = {
      method,
      headers: cleanHeaders
    };
    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      options.body = body;
    }

    const res = await fetch(reqUrl, options);
    return await serializeFetchResponse(res, reqUrl);
  }

  // Handle signed yt.fetch (InnerTube and playback stats reporting)
  const isStats = STATS_URL_PATTERN.test(reqUrl) && method === 'GET';
  const urlObj = new URL(reqUrl);
  const targetOrigin = isStats ? 'https://music.youtube.com' : urlObj.origin;

  // Gather cookies from URL origin and .youtube.com domain
  const [urlCookies, ytCookies] = await Promise.all([
    session.defaultSession.cookies.get({ url: targetOrigin }).catch(() => []),
    session.defaultSession.cookies.get({ domain: '.youtube.com' }).catch(() => [])
  ]);

  const cookieMap = new Map();
  for (const c of ytCookies) if (c.name && c.value) cookieMap.set(c.name, c.value);
  for (const c of urlCookies) if (c.name && c.value) cookieMap.set(c.name, c.value);
  const cookieList = Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value }));

  // Find signing secret in preferred order
  let secret = null;
  for (const name of ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID']) {
    const c = cookieList.find(x => x.name === name);
    if (c) {
      secret = c.value;
      break;
    }
  }

  if (!secret) {
    return {
      status: 401,
      headers: {},
      body: JSON.stringify({ error: 'unauthenticated', message: 'Not signed in to YouTube Music.' }),
      bodyEncoding: 'text',
      url: reqUrl
    };
  }

  const authState = await getYouTubeAuthState(false);
  const active = authState && authState.active;
  const authUser = (active && active.authUser) ? String(active.authUser) : '0';
  const pageId = (active && active.brand && active.id) ? active.id.split(':')[1] : null;

  // Filter out any page-sent identity headers to prevent conflicting headers
  const cleanHeaders = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (!IDENTITY_HEADERS.includes(key.toLowerCase())) {
      cleanHeaders[key] = value;
    }
  }

  // Set authoritative identity and YouTube origin headers
  cleanHeaders['Origin'] = targetOrigin;
  cleanHeaders['Referer'] = `${targetOrigin}/`;
  cleanHeaders['X-Origin'] = targetOrigin;
  cleanHeaders['Authorization'] = getSapisidHash(secret, targetOrigin);
  cleanHeaders['X-Goog-AuthUser'] = authUser;
  if (pageId && pageId !== 'own') {
    cleanHeaders['X-Goog-PageId'] = pageId;
  }
  cleanHeaders['Cookie'] = cookieList.map(c => `${c.name}=${c.value}`).join('; ');
  cleanHeaders['User-Agent'] = session.defaultSession.getUserAgent();

  let body = request.body;
  if (body !== undefined && request.bodyEncoding === 'base64') {
    body = Buffer.from(body, 'base64');
  }

  const options = {
    method,
    headers: cleanHeaders
  };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    options.body = body;
  }

  const res = await fetch(reqUrl, options);
  return await serializeFetchResponse(res, reqUrl);
});

async function createWindow() {
  // Completely remove default application menu
  Menu.setApplicationMenu(null);

  // Set up header rewriting to impersonate YouTube and allow audio stream fetching
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url;
    const headers = { ...details.requestHeaders };

    if (url.includes('music.youtube.com/youtubei/')) {
      headers['Origin'] = 'https://music.youtube.com';
      headers['Referer'] = 'https://music.youtube.com/';
      headers['X-Origin'] = 'https://music.youtube.com';
    } else if (url.includes('youtube.com/youtubei/')) {
      headers['Origin'] = 'https://www.youtube.com';
      headers['Referer'] = 'https://www.youtube.com/';
      headers['X-Origin'] = 'https://www.youtube.com';
    } else if (url.includes('s.youtube.com/api/stats/')) {
      headers['Origin'] = 'https://music.youtube.com';
      headers['Referer'] = 'https://music.youtube.com/';
      headers['X-Origin'] = 'https://music.youtube.com';
    } else if (url.includes('googlevideo.com/')) {
      if (url.includes('c=VISIONOS')) {
        delete headers['Origin'];
        delete headers['Referer'];
      } else {
        headers['Origin'] = 'https://www.youtube.com';
        headers['Referer'] = 'https://www.youtube.com/';
      }
    }

    callback({ requestHeaders: headers });
  });

  // Inject CORS headers on all received responses
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, HEAD'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    callback({ responseHeaders: headers });
  });

  // Load unpacked Chrome extension if packaged
  const extensionPath = path.join(__dirname, 'extension');
  if (fs.existsSync(extensionPath)) {
    try {
      await session.defaultSession.loadExtension(extensionPath, { allowFileAccess: true });
    } catch (err) {
      console.warn('Failed to load extension into session:', err);
    }
  }

  // Start internal static server
  const appDir = path.join(__dirname, 'app');
  const { server, port } = await startServer(appDir);
  localServer = server;

  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    title: 'BitChord',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    fullscreen: false,
    fullscreenable: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      webSecurity: false,
      devTools: false,
      backgroundThrottling: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck',
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Remove window menu bar
  mainWindow.setMenu(null);

  // Apply saved or default zoom scale once DOM is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const savedZoom = loadSavedZoom();
    mainWindow.webContents.setZoomFactor(savedZoom);
  });

  // Strictly block developer tools
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  // Intercept new window creations (Sign In, links, etc.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('accounts.google.com') || url.includes('music.youtube.com') || url.includes('youtube.com')) {
      openLoginWindow(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keyboard shortcuts: F11 fullscreen, Ctrl + +/-/0 zoom, block DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
      return;
    }

    // Zoom shortcuts (Ctrl + Plus/Equals, Ctrl + Minus, Ctrl + 0)
    if (input.control && input.type === 'keyDown') {
      if (input.key === '=' || input.key === '+' || input.key === 'Add') {
        adjustZoom(0.05);
        event.preventDefault();
        return;
      }
      if (input.key === '-' || input.key === '_' || input.key === 'Subtract') {
        adjustZoom(-0.05);
        event.preventDefault();
        return;
      }
      if (input.key === '0' || input.key === 'Num0') {
        resetZoom();
        event.preventDefault();
        return;
      }
    }

    // Block F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C
    if (
      (input.key === 'F12' && input.type === 'keyDown') ||
      (input.control && input.shift && ['i', 'j', 'c'].includes(input.key.toLowerCase()) && input.type === 'keyDown')
    ) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  // Close to tray behavior: closing window does not quit app and keeps music playing
  mainWindow.on('close', async (event) => {
    if (!isQuitting) {
      event.preventDefault();
      await session.defaultSession.cookies.flushStore();
      mainWindow.hide();
      return false;
    }
    await session.defaultSession.cookies.flushStore();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (localServer) {
      localServer.close();
      localServer = null;
    }
  });

  // Initialize System Tray
  createTray();

  // Initialize Discord Rich Presence
  discord.init(app.getPath('userData'), (discordState) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('discord-state-changed', discordState);
    }
  });

  await mainWindow.loadURL(`http://localhost:${port}`);
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  await session.defaultSession.cookies.flushStore();
});

app.on('window-all-closed', () => {
  // On Linux/Windows with tray, stay running in tray unless explicitly quit
  if (isQuitting) {
    if (localServer) {
      localServer.close();
      localServer = null;
    }
    app.quit();
  }
});
