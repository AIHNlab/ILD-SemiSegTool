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
