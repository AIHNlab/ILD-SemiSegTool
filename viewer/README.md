# viewer - OHIF v3 with the MONAI Label extension

This folder is the OHIF Viewers monorepo (v3.10, MIT licensed - see
`LICENSE`), trimmed to what the build needs. It is built into the `gateway`
image: after changing anything here, run `./manage.sh build gateway &&
./manage.sh up` in `docker/`.

## Our code

| Path | What |
|---|---|
| `extensions/monai-label/` | **The segmentation UI**: the MONAI Label panel, auto segmentation, semi-segmentation tools, Regional Stats, Preprocessing, save/load segmentations |
| `modes/monai-label/` | The "MONAI Label" mode: viewer layout and toolbar using the extension above |
| `platform/app/public/config/monai_label.js` | Build-time viewer config. When hosted, `docker/gateway/app-config.js` replaces it |
| `platform/app/public/config/default.js`, `google.js` | Not used by us, but OHIF's webpack config needs them |
| `platform/ui-next/src/components/Header/Header.tsx` | Small hook (`whiteLabeling.getMenuOptions`) that adds "Log out (user)" to the settings menu |

## The rest (OHIF itself - keep as is)

| Path | What |
|---|---|
| `platform/app` | The viewer application (routing, study list, plugin loading via `pluginConfig.json`) |
| `platform/core`, `platform/ui`, `platform/ui-next`, `platform/i18n` | OHIF's core services, UI components and translations |
| `platform/cli` | OHIF's command-line helper for creating extensions/modes |
| `extensions/*`, `modes/*` | OHIF's built-in viewer features (cornerstone rendering, DICOM SEG/SR/RT, PDF, video, ...) and modes, registered in `platform/app/pluginConfig.json` |
| `addOns/`, `patches/` | Extra build dependencies and a patch for `@cornerstonejs/tools`, applied at `yarn install` |
| Root config files | Build tooling the monorepo needs at its root (`package.json`, `yarn.lock`, `babel.config.js`, `.webpack/`, `version.txt`, `commit.txt`, ...) - they cannot be moved |
