const { webFrame } = require('electron');

const bridgeScript = `
(() => {
  const BRIDGE_CHANNEL = 'bitchord-bridge';
  const BRIDGE_PROTOCOL = 1;

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const req = event.data;
    if (!req || typeof req !== 'object' || req.channel !== BRIDGE_CHANNEL || req.direction !== 'to-extension') {
      return;
    }

    function reply(result) {
      window.postMessage({
        channel: BRIDGE_CHANNEL,
        protocol: BRIDGE_PROTOCOL,
        direction: 'to-page',
        id: req.id,
        ok: true,
        result: result
      }, location.origin);
    }

    function replyError(code, message) {
      window.postMessage({
        channel: BRIDGE_CHANNEL,
        protocol: BRIDGE_PROTOCOL,
        direction: 'to-page',
        id: req.id,
        ok: false,
        error: { code: code || 'internal', message: message || 'Error' }
      }, location.origin);
    }

    try {
      switch (req.method) {
        case 'ping':
          reply({
            version: '0.4.4',
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
        case 'spotify.setConnected':
        case 'spotify.signIn':
          reply({
            browserSignedIn: false,
            connected: false,
            signedIn: false,
            user: null,
            problem: null
          });
          break;

        case 'discord.state':
        case 'discord.presence':
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
            granted: (req.params && req.params.origins) || []
          });
          break;

        case 'lyrics.requestPermissions':
          reply({});
          break;

        case 'lyrics.fetch':
        case 'yt.fetch':
        case 'addon.fetch': {
          const fetchUrl = req.params && req.params.url;
          if (!fetchUrl) {
            replyError('invalid_params', 'Missing URL');
            return;
          }

          const fetchMethod = (req.params && req.params.method) || 'GET';
          const fetchHeaders = (req.params && req.params.headers) || {};
          const fetchBody = req.params && req.params.body;

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
          replyError('not_found', 'Method ' + req.method + ' not implemented');
          break;
      }
    } catch (err) {
      replyError('internal', err.message || String(err));
    }
  });
})();
`;

try {
  webFrame.executeJavaScript(bridgeScript);
} catch (e) {
  window.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('script');
    s.textContent = bridgeScript;
    document.documentElement.appendChild(s);
  });
}
