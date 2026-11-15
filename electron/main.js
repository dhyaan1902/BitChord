const { app, BrowserWindow, Menu, session, ipcMain, shell, Tray, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// Suppress security warnings in console
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

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

        res.writeHead(200, {
          'Content-Type': contentType,
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

  const cookies = await session.defaultSession.cookies.get({ domain: '.youtube.com' });
  const sapisidCookie = cookies.find(c => ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'].includes(c.name));

  if (!sapisidCookie || !sapisidCookie.value) {
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

  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const sapisid = sapisidCookie.value;

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
        'X-Youtube-Client-Name': '67',
        'X-Youtube-Client-Version': '1.20251006.03.00',
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
      throw new Error(`account_menu status ${res.status}`);
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
          'X-Youtube-Client-Name': '67',
          'X-Youtube-Client-Version': '1.20251006.03.00',
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
      signedIn: true,
      accounts: [{
        authUser: '0',
        name: 'YouTube Music User',
        email: null,
        avatarUrl: null,
        channels: [{
          id: '0:own',
          name: 'YouTube Music User',
          handle: null,
          avatarUrl: null,
          brand: false
        }]
      }],
      active: {
        id: '0:own',
        name: 'YouTube Music User',
        handle: null,
        avatarUrl: null,
        brand: false,
        authUser: '0'
      },
      problem: null
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

ipcMain.handle('yt-fetch', async (event, request) => {
  const cookies = await session.defaultSession.cookies.get({ domain: '.youtube.com' });
  const sapisidCookie = cookies.find(c => ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'].includes(c.name));
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  const headers = { ...(request.headers || {}) };
  headers['Origin'] = 'https://music.youtube.com';
  headers['Referer'] = 'https://music.youtube.com/';
  headers['X-Origin'] = 'https://music.youtube.com';
  headers['Cookie'] = cookieString;

  if (sapisidCookie && sapisidCookie.value) {
    headers['Authorization'] = getSapisidHash(sapisidCookie.value, 'https://music.youtube.com');
    headers['X-Goog-AuthUser'] = '0';
  }

  const options = {
    method: request.method || 'GET',
    headers: headers
  };
  if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
    options.body = request.body;
  }

  const res = await fetch(request.url, options);
  const text = await res.text();
  const resHeaders = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });

  return {
    status: res.status,
    headers: resHeaders,
    body: text,
    bodyEncoding: 'text',
    url: res.url || request.url
  };
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
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Remove window menu bar
  mainWindow.setMenu(null);

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

  // Keyboard shortcuts: allow F11 to toggle fullscreen, block DevTools shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
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
