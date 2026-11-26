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

// Phones/tablets (touch screen, no mouse): render the image views at 1 device
// pixel per CSS pixel. A phone at 2.6x draws ~7x the pixels for little
// visible gain on a small screen, and the 3D view's cost grows with every
// pixel - it was slow, and mobile browsers kill the page when the GPU stays
// busy too long. 2D slices are slightly softer on these devices.
// Panels and text stay sharp (only the image canvas reads this value).
(function () {
  const touchOnly =
    window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const MAX_RATIO = 1;
  if (touchOnly && window.devicePixelRatio > MAX_RATIO) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', { get: () => MAX_RATIO, configurable: true });
    } catch (e) {}
  }
})();

// Firefox (and some tablets): CT slices showed as flat grey squares. Where
// the browser offers EXT_texture_norm16 (Firefox does, Chrome on Mac
// doesn't), vtk.js stores the 16-bit CT as an R16_SNORM texture and draws it
// with linear filtering - which Firefox doesn't allow for that format, so it
// draws an empty texture ("texture's format is not texture-filterable").
// Hiding the extension makes every browser use the 32-bit float texture
// Chrome uses; that needs OES_texture_float_linear switched on for the
// context, which is done here too, as soon as a context is created (and, on
// GPUs without it, those textures are sampled nearest-pixel - see below).
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
      ['EXT_color_buffer_float', 'OES_texture_half_float_linear'].forEach(function (name) {
        try {
          getExtension(name);
        } catch (e) {}
      });
      let floatLinear = null;
      try {
        floatLinear = getExtension('OES_texture_float_linear');
      } catch (e) {}
      if (!floatLinear) {
        nearestForFloatTextures(ctx);
      }
    }
    return ctx;
  }
  // GPUs that can't smooth 32-bit float textures at all (no
  // OES_texture_float_linear - e.g. Samsung Xclipse tablets): the CT slices
  // stayed blank. Such textures are sampled "nearest pixel" instead, which
  // WebGL always allows - slightly blockier only when zoomed far in. Every
  // float texture is recorded when its storage is allocated, and smoothing
  // requests for it are turned into NEAREST.
  function nearestForFloatTextures(gl) {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      return;
    }
    const FLOAT_FORMATS = [0x822e, 0x8230, 0x8815, 0x8814]; // R32F, RG32F, RGB32F, RGBA32F
    const floatTextures = new WeakSet();
    const BINDING = {};
    BINDING[gl.TEXTURE_2D] = gl.TEXTURE_BINDING_2D;
    BINDING[gl.TEXTURE_3D] = gl.TEXTURE_BINDING_3D;
    BINDING[gl.TEXTURE_2D_ARRAY] = gl.TEXTURE_BINDING_2D_ARRAY;
    const texParameteri = gl.texParameteri.bind(gl);
    const bound = function (target) {
      return BINDING[target] ? gl.getParameter(BINDING[target]) : null;
    };
    const isFilter = function (pname) {
      return pname === gl.TEXTURE_MIN_FILTER || pname === gl.TEXTURE_MAG_FILTER;
    };
    ['texImage2D', 'texImage3D', 'texStorage2D', 'texStorage3D'].forEach(function (name) {
      const fn = gl[name].bind(gl);
      gl[name] = function (target, a, internalFormat) {
        const result = fn.apply(null, arguments);
        if (FLOAT_FORMATS.indexOf(internalFormat) >= 0) {
          const texture = bound(target);
          if (texture) {
            floatTextures.add(texture);
            texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          }
        }
        return result;
      };
    });
    gl.texParameteri = function (target, pname, param) {
      if (isFilter(pname) && param !== gl.NEAREST && floatTextures.has(bound(target))) {
        param = gl.NEAREST;
      }
      return texParameteri(target, pname, param);
    };
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

// Stylus (S Pen, Apple Pencil, ...) on the image views works like a mouse.
// Browsers deliver a pen as touch, and Cornerstone's brush has no touch
// support at all (the shape tools behave differently with touch), so a pen
// couldn't annotate. On the image views the pen's touch events are swallowed
// and its pointer events re-sent as mouse events: pen down = left button,
// hovering pen = mouse move (brush outline follows it). Fingers stay touch.
(function () {
  const VIEWPORT = '.cornerstone-viewport-element';
  const onViewport = function (target) {
    return !!(target && target.closest && target.closest(VIEWPORT));
  };
  let penDown = false;
  let penUpAt = 0;
  function send(type, e) {
    const target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: 0,
        buttons: penDown ? 1 : 0,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      })
    );
  }
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (e.pointerType !== 'pen' || !onViewport(e.target)) {
        return;
      }
      e.preventDefault();
      penDown = true;
      send('mousedown', e);
    },
    true
  );
  document.addEventListener(
    'pointermove',
    function (e) {
      if (e.pointerType !== 'pen' || (!penDown && !onViewport(e.target))) {
        return;
      }
      e.preventDefault();
      send('mousemove', e);
    },
    true
  );
  ['pointerup', 'pointercancel'].forEach(function (type) {
    document.addEventListener(
      type,
      function (e) {
        if (e.pointerType !== 'pen' || !penDown) {
          return;
        }
        penDown = false;
        penUpAt = Date.now();
        send('mouseup', e);
      },
      true
    );
  });
  // The pen's own touch events (and the browser's scroll/zoom gestures for
  // them) must not reach the viewer, or it would act on them twice.
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (type) {
    document.addEventListener(
      type,
      function (e) {
        const touches = Array.prototype.slice.call(e.changedTouches || []);
        // Browsers that don't mark them as 'stylus': the touches that come
        // while the pen is down (or right after it lifts) are the pen's.
        const pen =
          touches.length &&
          (touches.every(function (t) { return t.touchType === 'stylus'; }) ||
            ((penDown || Date.now() - penUpAt < 300) && (e.touches || []).length <= 1));
        if (pen && (penDown || onViewport(e.target))) {
          e.stopImmediatePropagation();
          if (e.cancelable) {
            e.preventDefault();
          }
        }
      },
      { capture: true, passive: false }
    );
  });
  // No browser panning/zooming on the image views - the viewer handles
  // touch gestures itself.
  const style = document.createElement('style');
  style.textContent = VIEWPORT + ', ' + VIEWPORT + ' * { touch-action: none; }';
  (document.head || document.documentElement).appendChild(style);
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
