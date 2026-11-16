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

      case 'discord.state': {
        const state = await ipcRenderer.invoke('discord-state');
        reply(state);
        break;
      }

      case 'discord.connect': {
        const state = await ipcRenderer.invoke('discord-connect');
        reply(state);
        break;
      }

      case 'discord.disconnect': {
        const state = await ipcRenderer.invoke('discord-disconnect');
        reply(state);
        break;
      }

      case 'discord.setEnabled': {
        const state = await ipcRenderer.invoke('discord-set-enabled', req.params && req.params.enabled);
        reply(state);
        break;
      }

      case 'discord.presence': {
        const res = await ipcRenderer.invoke('discord-presence', req.params);
        reply(res || {});
        break;
      }

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

// Broadcast Discord state changes into the BitChord Bridge event stream
ipcRenderer.on('discord-state-changed', (event, state) => {
  window.postMessage({
    channel: BRIDGE_CHANNEL,
    protocol: BRIDGE_PROTOCOL,
    direction: 'event',
    payload: { event: 'discord.state', data: state }
  }, location.origin);
});

// Ctrl + Mouse Wheel zoom control
window.addEventListener('wheel', (event) => {
  if (event.ctrlKey) {
    event.preventDefault();
    if (event.deltaY < 0) {
      ipcRenderer.send('zoom-in');
    } else if (event.deltaY > 0) {
      ipcRenderer.send('zoom-out');
    }
  }
}, { passive: false });

// Inject high-performance compositor optimizations on document start
document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.id = 'bitchord-perf-overrides';
  style.textContent = `
    html, body {
      scroll-behavior: smooth !important;
      text-rendering: auto !important;
    }
    .overflow-y-auto, .overflow-x-auto, [class*="overflow-y-auto"], [class*="overflow-x-auto"] {
      will-change: scroll-position !important;
      transform: translateZ(0) !important;
      -webkit-overflow-scrolling: touch !important;
    }
    [class*="backdrop-filter"] {
      transform: translateZ(0) !important;
      backface-visibility: hidden !important;
    }
    .group\\/art, .group\\/shelf, .group\\/row {
      contain: paint !important;
    }
  `;
  document.head.appendChild(style);
});
