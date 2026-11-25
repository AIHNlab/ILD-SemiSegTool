// OHIF configuration for the hosted (docker/) setup - mounted over the
// built viewer's app-config.js; after editing, run `./manage.sh restart gateway`.
// Differences from viewer/platform/app/public/config/monai_label.js (the local setup):
//   - images come straight from the logged-in user's own Orthanc
//     (/dicom-web, routed per user by the gateway) instead of through
//     MONAI Label's proxy;
//   - the MONAI Label panel talks to /monai/ on this same site;
//   - the settings (gear) menu has "Log out (<username>)" (needs the
//     getMenuOptions hook in ui-next Header.tsx); uploading is OHIF's own
//     "Upload" on the study list (dicomUploadEnabled).

// Safari: render the image views at normal (not Retina) resolution.
// Cornerstone draws all views into one hidden WebGL canvas and copies each
// view onto the page; Safari reads every copy back from the GPU, which made
// the brush (all views redraw on every mouse move) lag. At 1x there are 4x
// fewer pixels to draw and copy. Images look slightly softer on Retina
// screens in Safari only; panels and text stay sharp. Chrome/Edge copy on
// the GPU and keep full resolution. Set to false to turn this off.
const SAFARI_STANDARD_RESOLUTION = true;
(function () {
  const ua = navigator.userAgent;
  const isSafari = /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);
  if (SAFARI_STANDARD_RESOLUTION && isSafari && window.devicePixelRatio > 1) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true });
    } catch (e) {
      console.warn('Could not lower the rendering resolution for Safari', e);
    }
  }
})();

// Firefox (and some tablets): CT slices showed as flat grey squares. Where
// the browser offers EXT_texture_norm16 (Firefox does, Chrome on Mac
// doesn't), vtk.js stores the 16-bit CT as an R16_SNORM texture and draws it
// with linear filtering - which Firefox doesn't allow for that format, so it
// draws an empty texture ("texture's format is not texture-filterable").
// Hiding the extension makes every browser use the 32-bit float texture
// Chrome uses; that needs OES_texture_float_linear switched on for the
// context, which is done here too, as soon as a context is created.
(function () {
  const original = HTMLCanvasElement.prototype.getContext;
  const offscreen = typeof OffscreenCanvas !== 'undefined' ? OffscreenCanvas.prototype.getContext : null;
  const HIDDEN = ['EXT_texture_norm16'];
  function enable(ctx) {
    if (ctx && typeof ctx.getExtension === 'function' && !ctx.__ildPatched) {
      ctx.__ildPatched = true;
      const getExtension = ctx.getExtension.bind(ctx);
      const getSupported = ctx.getSupportedExtensions.bind(ctx);
      ctx.getExtension = function (name) {
        return HIDDEN.indexOf(name) >= 0 ? null : getExtension(name);
      };
      ctx.getSupportedExtensions = function () {
        return (getSupported() || []).filter(function (n) { return HIDDEN.indexOf(n) < 0; });
      };
      ['OES_texture_float_linear', 'EXT_color_buffer_float', 'OES_texture_half_float_linear'].forEach(function (name) {
        try {
          getExtension(name);
        } catch (e) {}
      });
    }
    return ctx;
  }
  HTMLCanvasElement.prototype.getContext = function (type) {
    const ctx = original.apply(this, arguments);
    return /webgl/i.test(type) ? enable(ctx) : ctx;
  };
  if (offscreen) {
    OffscreenCanvas.prototype.getContext = function (type) {
      const ctx = offscreen.apply(this, arguments);
      return /webgl/i.test(type) ? enable(ctx) : ctx;
    };
  }
})();

// Diagnostics: tells the server (backend log, `./manage.sh user-logs <user>`)
// what this browser can do for image rendering, and reports page errors, so
// a problem on someone's own device (tablet, another browser) can be found
// without its developer console. Sent once at load, then per error (max 30).
(function () {
  let sent = 0;
  function report(kind, data) {
    if (sent++ >= 30) {
      return;
    }
    try {
      const body = JSON.stringify(Object.assign({ kind: kind, page: location.href }, data)).slice(0, 8000);
      fetch('/monai/client-log', { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function webgl() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (!gl) {
        return { webgl2: false, webgl1: !!c.getContext('webgl') };
      }
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const ext = ['EXT_color_buffer_float', 'OES_texture_float_linear', 'EXT_texture_norm16'];
      return {
        webgl2: true,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        max3DTexture: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        extensions: ext.filter(function (e) { return !!gl.getExtension(e); }),
      };
    } catch (e) {
      return { webglError: String(e) };
    }
  }
  report('load', {
    ua: navigator.userAgent,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    memoryGB: navigator.deviceMemory,
    screen: screen.width + 'x' + screen.height + '@' + window.devicePixelRatio,
    gl: webgl(),
  });
  window.addEventListener('error', function (e) {
    report('error', { message: String(e.message), source: e.filename + ':' + e.lineno, stack: e.error && String(e.error.stack).slice(0, 2000) });
  });
  window.addEventListener('unhandledrejection', function (e) {
    const r = e.reason;
    report('rejection', { message: String((r && r.message) || r), stack: r && r.stack && String(r.stack).slice(0, 2000) });
  });
  const origError = console.error;
  console.error = function () {
    try {
      report('console.error', {
        message: Array.prototype.map.call(arguments, function (a) {
          return a instanceof Error ? a.message + ' ' + (a.stack || '') : typeof a === 'object' ? (function () { try { return JSON.stringify(a); } catch (x) { return String(a); } })() : String(a);
        }).join(' ').slice(0, 3000),
      });
    } catch (x) {}
    return origError.apply(console, arguments);
  };
})();

// Logged-in username, from the gateway (it knows it from the session cookie).
var currentUser = '';
fetch('/whoami', { cache: 'no-store' })
  .then(function (r) { return r.ok ? r.text() : ''; })
  .then(function (name) { currentUser = name.trim(); })
  .catch(function () {});

window.config = {
  routerBasename: '/ohif/',
  showStudyList: true,
  extensions: [],
  modes: [],
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  defaultDataSourceName: 'dicomweb',
  useSharedArrayBuffer: 'TRUE',
  monaiLabelServerUrl: '/monai/',
  // The logged-in user's own Orthanc REST API (the gateway routes it to them).
  // Enables the Delete button on each study in the study list.
  orthancRoot: '/orthanc',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'dicomweb',
      configuration: {
        friendlyName: 'My studies',
        name: 'Orthanc',
        wadoUriRoot: '/dicom-web',
        qidoRoot: '/dicom-web',
        wadoRoot: '/dicom-web',
        qidoSupportsIncludeField: true,
        supportsReject: true,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        // Ask Orthanc for plain uncompressed pixels (it converts on the server,
        // ~10 ms per slice) instead of whatever the study was stored as - e.g.
        // JPEG 2000, which the browser would have to decode slice by slice in
        // WebAssembly: seconds of CPU per scan, very slow on tablets and phones.
        // The gateway gzips the result on the wire (see Caddyfile).
        requestTransferSyntaxUID: '1.2.840.10008.1.2.1',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: true,
        supportsWildcard: true,
        dicomUploadEnabled: true,
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
        },
      },
    },
  ],
  whiteLabeling: {
    // Left: the tool's name (links back to the study list).
    createLogoComponentFn: function (React) {
      return React.createElement(
        'a',
        {
          href: '/ohif/',
          // The header otherwise treats a click on the logo area as "go to study list".
          onClick: function (e) { e.stopPropagation(); },
          style: { color: '#5acce6', fontWeight: 700, fontSize: '15px', textDecoration: 'none' },
        },
        'ILD SemiSeg'
      );
    },
    // Extra settings-menu (gear) items: "Log out (<username>)".
    getMenuOptions: function () {
      return [
        {
          title: currentUser ? 'Log out (' + currentUser + ')' : 'Log out',
          icon: 'power-off',
          onClick: function () { window.location.href = '/logout'; },
        },
      ];
    },
  },
};
