// Preload script for BitChord Electron app
// Implements the BitChord bridge protocol so the web app detects the extension capabilities

window.addEventListener('message', async (event) => {
  const req = event.data;
  if (!req || req.channel !== 'bitchord-bridge' || req.direction !== 'to-extension') {
    return;
  }

  function reply(result) {
    window.postMessage({
      channel: 'bitchord-bridge',
      protocol: 1,
      direction: 'from-extension',
      id: req.id,
      ok: true,
      result: result
    }, '*');
  }

  function replyError(code, message) {
    window.postMessage({
      channel: 'bitchord-bridge',
      protocol: 1,
      direction: 'from-extension',
      id: req.id,
      ok: false,
      error: { code: code || 'internal', message: message || 'Error' }
    }, '*');
  }

  try {
    switch (req.method) {
      case 'ping':
        reply({
          version: '1.0.0',
          protocol: 1,
          browser: 'chromium',
          capabilities: ['yt', 'yt.auth', 'yt.stats', 'addon', 'lyrics', 'spotify', 'discord']
        });
        break;

      case 'yt.authState':
      case 'yt.selectChannel':
      case 'yt.setConnected':
        reply({
          browserSignedIn: false,
          connected: false,
          signedIn: false,
          accounts: [],
          active: null,
          problem: null
        });
        break;

      case 'spotify.authState':
        reply({
          browserSignedIn: false,
          connected: false,
          signedIn: false,
          user: null,
          problem: null
        });
        break;

      case 'discord.state':
        reply({
          available: false,
          connected: false,
          enabled: false,
          user: null,
          gateway: 'off',
          problem: null
        });
        break;

      case 'lyrics.permissions':
        reply({
          granted: req.params?.origins || []
        });
        break;

      case 'lyrics.requestPermissions':
        reply({});
        break;

      case 'lyrics.fetch':
      case 'yt.fetch':
      case 'addon.fetch': {
        const fetchUrl = req.params?.url;
        if (!fetchUrl) {
          replyError('invalid_params', 'Missing URL');
          return;
        }

        const fetchMethod = req.params?.method || 'GET';
        const fetchHeaders = req.params?.headers || {};
        const fetchBody = req.params?.body;

        const options = {
          method: fetchMethod,
          headers: fetchHeaders
        };
        if (fetchBody && fetchMethod !== 'GET' && fetchMethod !== 'HEAD') {
          options.body = fetchBody;
        }

        const res = await fetch(fetchUrl, options);
        const text = await res.text();
        const resHeaders = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });

        reply({
          status: res.status,
          headers: resHeaders,
          body: text,
          bodyEncoding: 'text',
          url: res.url || fetchUrl
        });
        break;
      }

      default:
        replyError('not_found', `Method ${req.method} not implemented`);
        break;
    }
  } catch (err) {
    replyError('internal', err.message || String(err));
  }
});
