const { app, BrowserWindow, Menu, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

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

    // Try port 5173 first (default trusted origin for BitChord), or fallback to random free port
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

let mainWindow = null;
let localServer = null;

async function createWindow() {
  // Completely remove default application menu (removes File, Edit, View, Toggle DevTools, etc.)
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

  // Start internal static server
  const appDir = path.join(__dirname, 'app');
  const { server, port } = await startServer(appDir);
  localServer = server;

  const iconPath = path.join(__dirname, 'icon.png');

  mainWindow = new BrowserWindow({
    title: 'BitChord',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    width: 1280,
    height: 800,
    fullscreen: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1f1f1f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
    mainWindow.setFullScreen(true);
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (localServer) {
      localServer.close();
      localServer = null;
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
