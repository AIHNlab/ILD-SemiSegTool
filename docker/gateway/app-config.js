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
