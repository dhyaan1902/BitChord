const { ipcRenderer } = require('electron');

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
      case 'ping': {
        const info = await ipcRenderer.invoke('get-extension-info');
        reply(info);
        break;
      }

      case 'yt.authState': {
        const state = await ipcRenderer.invoke('get-yt-auth-state', req.params && req.params.refresh);
        reply(state);
        break;
      }

      case 'yt.selectChannel': {
        const state = await ipcRenderer.invoke('yt-select-channel', req.params && req.params.channelId);
        reply(state);
        break;
      }

      case 'yt.setConnected': {
        const state = await ipcRenderer.invoke('yt-set-connected', req.params && req.params.connected);
        reply(state);
        break;
      }

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

      case 'yt.fetch': {
        const response = await ipcRenderer.invoke('yt-fetch', req.params);
        reply(response);
        break;
      }

      case 'lyrics.fetch':
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
        const resHeaders = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });

        const contentType = res.headers.get('content-type') || '';
        const textual = /json|text|javascript|xml|html/.test(contentType) || !contentType;
        let body;
        let bodyEncoding = 'text';

        if (textual) {
          body = await res.text();
        } else {
          const buffer = await res.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          body = btoa(binary);
          bodyEncoding = 'base64';
        }

        reply({
          status: res.status,
          headers: resHeaders,
          body: body,
          bodyEncoding: bodyEncoding,
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
