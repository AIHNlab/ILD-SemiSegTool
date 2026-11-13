/*
Copyright (c) MONAI Consortium
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { Icon } from '@ohif/ui';
import './MonaiLabelPanel.css';
import AutoSegmentation from './actions/AutoSegmentation';
import SemiSegmentation from './actions/SemiSegmentation';
import ClassPrompts from './actions/ClassPrompts';
import ActiveLearning from './actions/ActiveLearning';
import RegionalStats from './actions/RegionalStats';
import Preprocessing from './actions/Preprocessing';
import MonaiLabelClient from '../services/MonaiLabelClient';
import { hideNotification, getLabelColor, describeError } from '../utils/GenericUtils';
import { Enums } from '@cornerstonejs/tools';
import { cache } from '@cornerstonejs/core';
import SegmentationReader from '../utils/SegmentationReader';
import { compressIfSupported, decodeLabelmap, encodeLabelmap, isRle } from '../utils/labelmapRle';
import { copyLabelmap, notifyModified, sliceArrays, writeLabelmap } from '../utils/labelmapAccess';
import annotationHistory from '../utils/AnnotationHistory';
import { currentSegmentsInfo } from '../utils/SegUtils';
import SettingsTable from './SettingsTable';
import * as cornerstoneTools from '@cornerstonejs/tools';
import optionsInputDialog from './OptionsInputDialog';
import saveSegmentationDialog from './SaveSegmentationDialog';
import loadSegmentationDialog, { SavedSegmentation } from './LoadSegmentationDialog';

const SaveIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20px"
    height="20px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </svg>
);

const LoadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20px"
    height="20px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </svg>
);


export default class MonaiLabelPanel extends Component<any, any> {
  static propTypes = {
    commandsManager: PropTypes.any,
    servicesManager: PropTypes.any,
    extensionManager: PropTypes.any,
  };

  notification: any;
  settings;
  actions: {
    activelearning: any;
    segmentation: any;
    semisegmentation: any;
    classprompts: any;
    regionalstats: any;
    preprocessing: any;
  };
  serverURI = 'http://127.0.0.1:8000';
  // Tracked purely for the Save Segmentation dialog's auto-filled "Model"
  // field - whichever model most recently produced a successful Run,
  // across any tab (see onModelUsed, called from AutoSegmentation/
  // SemiSegmentation/ClassPrompts in place of the old autosave-after-Run).
  lastUsedModel = '';

  constructor(props) {
    super(props);

    const { uiNotificationService } = props.servicesManager.services;
    this.notification = uiNotificationService;
    this.settings = React.createRef();
    this.actions = {
      activelearning: React.createRef(),
      segmentation: React.createRef(),
      semisegmentation: React.createRef(),
      classprompts: React.createRef(),
      regionalstats: React.createRef(),
      preprocessing: React.createRef(),
    };

    this.state = {
      info: { models: [], datasets: [] },
      action: {},
      options: {},
      busyActions: {},
      // Saves loaded together (Load dialog "Load selected together"):
      // {seriesUID, saves, top} - the panel then offers which one is on top.
      mergedLayers: null,
    };
  }

  onModelUsed = (model) => {
    this.lastUsedModel = model;
  };

  setBusy = (action, isBusy) => {
    this.setState((prevState) => ({
      busyActions: { ...prevState.busyActions, [action]: isBusy },
    }));
  };

  client = () => {
    const settings =
      this.settings && this.settings.current && this.settings.current.state
        ? this.settings.current.state
        : null;
    return new MonaiLabelClient(settings ? settings.url : this.serverURI);
  };

  segmentColor(label) {
    const color = getLabelColor(label);
    const rgbColor = [];
    for (const key in color) {
      rgbColor.push(color[key]);
    }
    rgbColor.push(255);
    return rgbColor;
  }

  getActiveViewportInfo = () => {
    const { viewportGridService, displaySetService } =
      this.props.servicesManager.services;
    const { viewports, activeViewportId } = viewportGridService.getState();
    const viewport = viewports.get(activeViewportId);
    const displaySet = displaySetService.getDisplaySetByUID(
      viewport.displaySetInstanceUIDs[0]
    );

    // viewportId = viewport.viewportId
    // SeriesInstanceUID = displaySet.SeriesInstanceUID;
    // StudyInstanceUID = displaySet.StudyInstanceUID;
    // FrameOfReferenceUID = displaySet.instances[0].FrameOfReferenceUID;
    // displaySetInstanceUID = displaySet.displaySetInstanceUID;
    // numImageFrames = displaySet.numImageFrames;
    return { viewport, displaySet };
  };

  onInfo = async (serverURI) => {
    const nid = this.notification.show({
      title: 'MONAI Label',
      message: 'Connecting to MONAI Label',
      type: 'info',
      duration: 2000,
    });

    this.serverURI = serverURI;
    const response = await this.client().info();

    hideNotification(nid, this.notification);
    if (response.status !== 200) {
      console.error('Failed to connect to MONAI Label', response);
      this.notification.show({
        title: 'MONAI Label',
        message: `Failed to connect to MONAI Label: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
      return;
    }
    console.log(response.data);

    this.notification.show({
      title: 'MONAI Label',
      message: 'Connected to MONAI Label - Successful',
      type: 'success',
      duration: 2000,
    });

    const all_models = response.data.models;
    const all_model_names = Object.keys(all_models);
    const deepgrow_models = all_model_names.filter(
      (m) => all_models[m].type === 'deepgrow'
    );
    const deepedit_models = all_model_names.filter(
      (m) => all_models[m].type === 'deepedit'
    );
    const vista3d_models = all_model_names.filter(
      (m) => all_models[m].type === 'vista3d'
    );
    const segmentation_models = all_model_names.filter(
      (m) => all_models[m].type === 'segmentation'
    );
    const models = deepgrow_models
      .concat(deepedit_models)
      .concat(vista3d_models)
      .concat(segmentation_models);
    const all_labels = response.data.labels;

    const modelLabelToIdxMap = {};
    const modelIdxToLabelMap = {};
    const modelLabelNames = {};
    const modelLabelIndices = {};
    for (const model of models) {
      const labels = all_models[model]['labels'];
      modelLabelToIdxMap[model] = {};
      modelIdxToLabelMap[model] = {};
      if (Array.isArray(labels)) {
        for (let label_idx = 1; label_idx <= labels.length; label_idx++) {
          const label = labels[label_idx - 1];
          all_labels.push(label);
          modelLabelToIdxMap[model][label] = label_idx;
          modelIdxToLabelMap[model][label_idx] = label;
        }
      } else {
        for (const label of Object.keys(labels)) {
          const label_idx = labels[label];
          all_labels.push(label);
          modelLabelToIdxMap[model][label] = label_idx;
          modelIdxToLabelMap[model][label_idx] = label;
        }
      }
      modelLabelNames[model] = [
        ...Object.keys(modelLabelToIdxMap[model]),
      ].sort();
      modelLabelIndices[model] = [...Object.keys(modelIdxToLabelMap[model])]
        .sort()
        .map(Number);
    }

    const labelsOrdered = [...new Set(all_labels)].sort();
    const segmentations = [
      {
        segmentationId: '1',
        representation: {
          type: Enums.SegmentationRepresentations.Labelmap,
        },
        config: {
          label: 'Segmentations',
          segments: labelsOrdered.reduce((acc, label, index) => {
            acc[index + 1] = {
              segmentIndex: index + 1,
              label: label,
              active: index === 0, // First segment is active
              locked: false,
              color: this.segmentColor(label),
            };
            return acc;
          }, {}),
        },
      },
    ];

    const initialSegs = segmentations[0].config.segments;
    // The labelmap itself is NOT created here: OHIF builds it in one
    // synchronous block (a labelmap image per CT slice, a volume, GPU
    // textures for every viewport) that froze the page for seconds right
    // after connecting, while slices were still loading. It's created on
    // first use instead - see ensureSegmentation.
    this.segmentationsSpec = segmentations;

    const info = {
      models: models,
      labels: labelsOrdered,
      data: response.data,
      modelLabelToIdxMap: modelLabelToIdxMap,
      modelIdxToLabelMap: modelIdxToLabelMap,
      modelLabelNames: modelLabelNames,
      modelLabelIndices: modelLabelIndices,
      initialSegs: initialSegs,
    };

    console.log(info);
    this.setState({ info: info });
    this.setState({ isDataReady: true }); // Mark as ready
    this.setState({ options: {} });
  };

  private segmentationsSpec = null;
  // The save(s) currently shown, for marking them in the Load dialog:
  // {seriesUID, tags} - cleared when something else is loaded from a file.
  private loadedSaves: { seriesUID: string; tags: string[] } | null = null;
  private segmentationCreation: Promise<void> | null = null;

  // Creates the segmentation labelmap the first time something needs it (an
  // AI result, loading a save, the brush) - not on connect, see onInfo. Safe
  // to call any number of times; concurrent callers share one creation.
  ensureSegmentation = async () => {
    const { segmentationService } = this.props.servicesManager.services;
    if (segmentationService.getSegmentation('1')) {
      await this.restoreSegmentationOnViewports(); // e.g. after the 3D layout
      return;
    }
    if (!this.segmentationsSpec) {
      return;
    }
    if (!this.segmentationCreation) {
      const segmentations = this.segmentationsSpec;
      this.segmentationCreation = (async () => {
        const nid = `segprep-${Date.now()}`;
        this.notification.show({ id: nid, title: 'MONAI Label', message: 'Preparing the segmentation layer...', type: 'loading' });
        await new Promise((resolve) => setTimeout(resolve, 50)); // let the toast paint first
        try {
          await this.props.commandsManager.runCommand('loadSegmentationsForViewport', { segmentations });
          // The labelmap VOLUME is built asynchronously after that command
          // returns (cornerstone converts the per-slice labelmap once the
          // representation reaches a volume viewport). Writing a result before
          // it exists would silently drop it, so wait for it.
          const deadline = Date.now() + 20000;
          while (!this.labelmapVolume() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const applyColors = () => {
            const { viewport } = this.getActiveViewportInfo();
            const segments = segmentations[0].config.segments;
            for (const key of Object.keys(segments)) {
              cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
                viewport.viewportId,
                '1',
                segments[key].segmentIndex,
                segments[key].color
              );
            }
          };
          applyColors();
          // Again shortly after, in case the representation was still settling
          // on the viewport (the old connect code waited a second for this).
          setTimeout(() => {
            try {
              applyColors();
            } catch (e) {
              console.warn('Could not set segment colors', e);
            }
          }, 500);
        } finally {
          this.notification.hide(nid);
        }
      })().finally(() => {
        this.segmentationCreation = null;
      });
    }
    return this.segmentationCreation;
  };

  // The labelmap volume, or null if it doesn't exist yet (see
  // ensureSegmentation) - segmentationService.getLabelmapVolume throws then.
  labelmapVolume = () => {
    const { segmentationService } = this.props.servicesManager.services;
    return segmentationService.getSegmentation('1') ? segmentationService.getLabelmapVolume('1') : null;
  };

  onSelectActionTab = (name) => {
    for (const action of Object.keys(this.actions)) {
      if (this.state.action === action) {
        if (this.actions[action].current) {
          this.actions[action].current.onLeaveActionTab();
        }
      }
    }

    for (const action of Object.keys(this.actions)) {
      if (name === action) {
        if (this.actions[action].current) {
          this.actions[action].current.onEnterActionTab();
        }
      }
    }
    this.setState({ action: name });
  };

  updateView = async (
    response,
    model_id,
    labels,
    override = false,
    label_class_unknown = false,
    sidx = -1,
    // {xmin, ymin, xmax, ymax} in voxel-index space, all slices - restricts
    // the override merge below to this in-plane box. Without it, "preserve
    // other classes" only compares label VALUES, not location: a second,
    // spatially unrelated run whose result happens to contain the same
    // class value anywhere wipes every voxel with that value everywhere,
    // including an earlier, disjoint ROI's result.
    xyBounds = null,
    // 'add' (default): merge response voxels in as this class, and, within
    // xyBounds, also let the model correct/replace whatever's already
    // there (used by the point/rectangle/freehand ROI prompts, where the
    // whole point is "redo this region"). 'remove': the response is a
    // propagated brush-erase mask (see SemiSegmentation.tsx's
    // buildBrushParamsList) - wherever it's nonzero, clear that voxel
    // instead of writing it, and only if it's currently this same class.
    // 'add-brush': the response is a propagated brush-PAINT mask - only
    // write voxels where it's nonzero, and never clear anything else in
    // xyBounds. Unlike plain 'add', a brush stroke is already a deliberate,
    // correct edit - the propagation's job is purely to extend it to other
    // slices, not to let SAM2's padded margin "correct" existing,
    // untouched same-class mask nearby.
    mode = 'add'
  ) => {
    console.log('UpdateView: ', {
      model_id,
      labels,
      override,
      label_class_unknown,
      sidx,
      xyBounds,
      mode,
    });

    await this.ensureSegmentation();
    const labelNames = {};
    const currentSegs = currentSegmentsInfo(
      this.props.servicesManager.services.segmentationService
    );
    const modelToSegMapping = {};
    modelToSegMapping[0] = 0;

    let tmp_model_seg_idx = 1;
    for (const label of labels) {
      const s = currentSegs.info[label];
      if (!s) {
        for (let i = 1; i <= 255; i++) {
          if (!currentSegs.indices.has(i)) {
            labelNames[label] = i;
            currentSegs.indices.add(i);
            break;
          }
        }
      } else {
        labelNames[label] = s.segmentIndex;
      }

      const seg_idx = labelNames[label];
      let model_seg_idx = this.state.info.modelLabelToIdxMap[model_id][label];
      model_seg_idx = model_seg_idx ? model_seg_idx : tmp_model_seg_idx;
      modelToSegMapping[model_seg_idx] = 0xff & seg_idx;
      tmp_model_seg_idx++;
    }
    console.log('Index Remap', labels, modelToSegMapping);

    // The model's value -> this session's segment index, as a lookup table:
    // the same rule for every voxel, so it's worked out once per value (256)
    // instead of once per voxel (~80 million).
    const lut = new Uint8Array(256);
    for (let midx = 0; midx < 256; midx++) {
      const sidxForValue = modelToSegMapping[midx];
      if (midx && sidxForValue) {
        lut[midx] = sidxForValue;
      } else if (override && label_class_unknown && labels.length === 1) {
        lut[midx] = midx ? labelNames[labels[0]] : 0;
      } else if (labels.length > 0) {
        lut[midx] = 0;
      } else {
        lut[midx] = midx;
      }
    }

    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = this.labelmapVolume();
    if (!volumeLoadObject) {
      console.error('Segmentation layer not available - result not shown');
      this.notification.show({
        title: 'MONAI Label',
        message: 'The result arrived, but the segmentation layer is not ready yet - please run it again.',
        type: 'error',
        duration: 10000,
      });
      return;
    }
    const { voxelManager } = volumeLoadObject;
    const [width, height, depth] = volumeLoadObject.dimensions || [];
    const total = width * height * depth;

    // AI results normally arrive run-length encoded (result_format 'rle' -
    // see MonaiLabelClient._infer): rebuilt with block fills. A plain NRRD
    // (older server) still works, remapped voxel by voxel.
    let convertedData;
    let present;
    if (isRle(response.data)) {
      ({ data: convertedData, present } = decodeLabelmap(response.data, total, lut));
    } else {
      const ret = SegmentationReader.parseNrrdData(response.data);
      if (!ret) {
        throw new Error('Failed to parse NRRD data');
      }
      convertedData = new Uint8Array(ret.image);
      present = new Uint8Array(256);
      for (let i = 0; i < convertedData.length; i++) {
        const v = lut[convertedData[i]];
        convertedData[i] = v;
        present[v] = 1;
      }
    }

    if (override === true) {
      const sliceLength = width * height;
      // Only the region this run covered is visited (not the whole volume):
      // the slice the run was for (sidx), the in-plane box xyBounds, and -
      // SAM2 runs only, see SemiSegmentation.tsx's SAM2_MAX_FRAMES_TO_TRACK -
      // xyBounds.zmin/zmax, the slices that model actually tracked. Outside
      // them the result array is just a zero-filled placeholder, so writing
      // it would wipe unrelated segmentation; and outside the box, "preserve
      // other classes" must not touch an earlier, disjoint ROI's result.
      let z0 = 0;
      let z1 = depth - 1;
      let y0 = 0;
      let y1 = height - 1;
      let x0 = 0;
      let x1 = width - 1;
      if (sidx >= 0) {
        z0 = z1 = sidx;
      }
      if (xyBounds && width) {
        x0 = Math.max(x0, xyBounds.xmin);
        x1 = Math.min(x1, xyBounds.xmax);
        y0 = Math.max(y0, xyBounds.ymin);
        y1 = Math.min(y1, xyBounds.ymax);
        if (xyBounds.zmin != null) {
          z0 = Math.max(z0, xyBounds.zmin);
        }
        if (xyBounds.zmax != null) {
          z1 = Math.min(z1, xyBounds.zmax);
        }
      }
      console.log('merge region: ', { mode, x0, x1, y0, y1, z0, z1, dimensions: volumeLoadObject.dimensions });

      // Edited in place in the live slices (labelmapAccess) - no whole-volume
      // copy - and only slices z0..z1 are redrawn.
      const arrays = sliceArrays(volumeLoadObject);
      const full = arrays ? null : voxelManager?.getCompleteScalarDataArray();
      let changed = 0;
      for (let z = z0; z <= z1; z++) {
        const current = arrays ? arrays[z] : full.subarray(z * sliceLength, (z + 1) * sliceLength);
        const offset = z * sliceLength;
        for (let y = y0; y <= y1; y++) {
          for (let j = y * width + x0, end = y * width + x1; j <= end; j++) {
            const v = convertedData[offset + j];
            if (mode === 'remove') {
              // Brush-erase propagation: clear exactly the voxels the model
              // tracked the erased region onto, and only if they're currently
              // this same class - never "response says 0 here, write 0",
              // which would wipe every background voxel in the padded box.
              if (v !== 0 && current[j] === v) {
                current[j] = 0;
                changed++;
              }
            } else if (mode === 'add-brush') {
              // Brush-paint propagation: only ADD the tracked voxels, never
              // clear anything - a brush stroke is a deliberate edit, so
              // SAM2's padded margin mustn't "correct" untouched mask nearby.
              if (v !== 0) {
                current[j] = v;
                changed++;
              }
            } else if (v !== 255 && present[current[j]]) {
              // 'add': within the region, the model redoes the classes it
              // returned (and background); other classes are kept.
              current[j] = v;
              changed++;
            }
          }
        }
      }
      console.log('merge done: ', { mode, changed });
      const slices = z1 >= z0 ? Array.from({ length: z1 - z0 + 1 }, (_, k) => z0 + k) : [];
      if (arrays) {
        notifyModified(volumeLoadObject, slices);
      } else if (full) {
        writeLabelmap(volumeLoadObject, full, slices);
      }
      return;
    }

    // One compact undo step for the whole result - no full-volume diff.
    annotationHistory.recordReplace(() => writeLabelmap(volumeLoadObject, convertedData), convertedData);
    console.log("updated the segmentation's scalar data");
  };

  openConfigurations = (e) => {
    e.preventDefault();

    const { uiDialogService } = this.props.servicesManager.services;
    optionsInputDialog(
      uiDialogService,
      this.state.options,
      this.state.info,
      (options, actionId) => {
        if (actionId === 'save' || actionId == 'reset') {
          this.setState({ options: options });
        }
      }
    );
  };

  async componentDidMount() {
    this.watchViewports();
    if (this.state.isDataReady) {
      return;
    }

    console.log('(Component Mounted) Ready to Connect to MONAI Server...');
    // await this.onInfo();
  }

  componentWillUnmount() {
    this.viewportSubscriptions.forEach((s) => s?.unsubscribe?.());
    this.viewportSubscriptions = [];
    clearTimeout(this.restoreTimer);
  }

  // Switching layouts (e.g. 3D and back to 2D) rebuilds the viewports, and
  // OHIF only puts a segmentation back on a new viewport that is the same
  // kind as one it was shown on before - so after 3D the 2D viewports came
  // back without it (and Load/AI results then wrote into a layer nothing
  // showed). Whenever the viewports change, show it again on every 2D
  // viewport of the same scan.
  private viewportSubscriptions = [];
  private restoreTimer = null;
  watchViewports = () => {
    const { cornerstoneViewportService, viewportGridService } = this.props.servicesManager.services;
    const later = () => {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = setTimeout(() => this.restoreSegmentationOnViewports(), 300);
    };
    this.viewportSubscriptions = [
      cornerstoneViewportService?.subscribe?.(cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, later),
      viewportGridService?.subscribe?.(viewportGridService.EVENTS.LAYOUT_CHANGED, later),
      viewportGridService?.subscribe?.(viewportGridService.EVENTS.GRID_STATE_CHANGED, later),
    ].filter(Boolean);
  };

  restoreSegmentationOnViewports = async () => {
    const { segmentationService, cornerstoneViewportService, viewportGridService } =
      this.props.servicesManager.services;
    try {
      if (!segmentationService.getSegmentation('1')) {
        return;
      }
      // The scan it belongs to: the labelmap's frame of reference, else that
      // of a viewport still showing it.
      const viewportIds = Array.from(viewportGridService.getState().viewports.keys()) as string[];
      let frameOfReference = this.labelmapVolume()?.metadata?.FrameOfReferenceUID;
      for (const id of segmentationService.getViewportIdsWithSegmentation('1') || []) {
        frameOfReference ||= cornerstoneViewportService.getCornerstoneViewport(id)?.getFrameOfReferenceUID?.();
      }
      if (!frameOfReference) {
        return;
      }
      for (const viewportId of viewportIds) {
        const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportId);
        if (!viewport || viewport.type === 'volume3d') {
          continue; // not rendered yet, or 3D (shows surfaces, added by OHIF)
        }
        if (viewport.getFrameOfReferenceUID?.() !== frameOfReference) {
          continue; // a different scan
        }
        if (segmentationService.getSegmentationRepresentations(viewportId, { segmentationId: '1' })?.length) {
          continue;
        }
        await segmentationService.addSegmentationRepresentation(viewportId, {
          segmentationId: '1',
          type: Enums.SegmentationRepresentations.Labelmap,
        });
      }
    } catch (e) {
      console.warn('Could not show the segmentation on all viewports', e);
    }
  };

  onOptionsConfig = () => {
    return this.state.options;
  };

  // Saves go to the server, in the logged-in user's own store (one file per
  // save, tag 'save-<timestamp>'), so they can be loaded again from any device
  // (Load dialog) and Regional Stats reads them (backend/lib/regional_stats.py).
  onSaveSegmentation = async (encoded) => {
    // Shown at once, then replaced in place (same id) by the result.
    const nid = `save-${Date.now()}`;
    this.notification.show({ id: nid, title: 'MONAI Label', message: 'Saving segmentation on the server...', type: 'loading' });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the toast paint first
    const saved = await this.saveToServer(encoded);
    if (saved === null) {
      this.notification.hide(nid);
      return;
    }
    this.notification.show({
      id: nid,
      title: 'MONAI Label',
      message: saved ? 'Segmentation saved on the server' : 'Saving failed - please try again',
      type: saved ? 'success' : 'error',
      duration: saved ? 4000 : 10000,
    });
  };

  // Auto-fills the confirm dialog from the current segmentation state:
  // whichever model most recently ran (onModelUsed), and whichever classes
  // actually have voxels right now. The labelmap is encoded once here and the
  // same upload is sent on confirm.
  onClickSaveSegmentation = (e) => {
    e.preventDefault();
    const encoded = this.encodeSegmentation();
    if (!encoded) {
      return;
    }
    const { uiDialogService } = this.props.servicesManager.services;
    const classes = encoded.classes.map((c) => c.name);
    saveSegmentationDialog(uiDialogService, { model: this.lastUsedModel, classes }, () => {
      this.onSaveSegmentation(encoded);
    });
  };

  // The current segmentation in its light upload form (utils/labelmapRle.js)
  // plus what the server needs to write the stored .nrrd: geometry, and the
  // classes with voxels as {name, index, color}. Voxel indices are only
  // meaningful within one session (the alphabetical union of whatever models
  // the server has loaded - see onInfo), so the file records each class's NAME
  // next to its index; onImportSegmentationFile remaps by name.
  // null if there's nothing to save (already reported).
  encodeSegmentation = () => {
    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = this.labelmapVolume();
    const scalarData = volumeLoadObject ? copyLabelmap(volumeLoadObject) : null;
    const { displaySet } = this.getActiveViewportInfo();
    const nothing = () => {
      this.notification.show({ title: 'MONAI Label', message: 'Nothing to save yet', type: 'warning', duration: 4000 });
      return null;
    };
    if (!scalarData || !displaySet) {
      return nothing();
    }

    const { parts, seen } = encodeLabelmap(scalarData);
    const { info } = currentSegmentsInfo(segmentationService);
    const classes = Object.keys(info)
      .map((name) => ({ name, index: info[name].segmentIndex, color: info[name].color }))
      .filter((c) => c.index > 0 && c.index < 256 && seen[c.index])
      .sort((a, b) => a.index - b.index);
    if (!classes.length) {
      return nothing();
    }

    return {
      parts,
      classes,
      displaySet,
      geometry: {
        sizes: Array.from(volumeLoadObject.dimensions),
        spacing: Array.from(volumeLoadObject.spacing),
        direction: Array.from(volumeLoadObject.direction),
        origin: Array.from(volumeLoadObject.origin),
      },
    };
  };

  // Stores the current segmentation on the server under its own
  // 'save-<timestamp>' tag; the server writes the .nrrd (backend/lib/label_upload.py).
  // Returns true/false, or null if there was nothing to save (already
  // reported); callers own the success/failure notification.
  saveToServer = async (encoded = this.encodeSegmentation()) => {
    if (!encoded) {
      return null;
    }
    const savedAt = new Date();
    const { displaySet } = encoded;
    try {
      const body = await compressIfSupported(new Blob(encoded.parts));
      const response = await this.client().save_label(
        displaySet.SeriesInstanceUID,
        body,
        {
          model: this.lastUsedModel || '',
          classes: encoded.classes,
          geometry: encoded.geometry,
          study_instance_uid: displaySet.StudyInstanceUID,
          series_instance_uid: displaySet.SeriesInstanceUID,
          saved_at: savedAt.toISOString(),
        },
        `save-${savedAt.getTime()}`,
        'label.ildrle'
      );
      if (response.status !== 200) {
        console.error('Failed to save segmentation to the server', response);
        return false;
      }
      return true;
    } catch (e) {
      console.error('Failed to save segmentation to the server', e);
      return false;
    }
  };

  // Loads several saves layered into one (server: merge_saved_labels) -
  // largest underneath, or `top` (a save's tag) on top - and remembers them so
  // the panel's "Merged layers" box can switch which one is on top.
  loadMerged = async (seriesUID, saves, top) => {
    const nid = `load-${Date.now()}`;
    this.notification.show({ id: nid, title: 'MONAI Label', message: `Merging ${saves.length} saved segmentations...`, type: 'loading' });
    try {
      const r = await this.client().download_label_merged(seriesUID, saves.map(s => s.tag), top);
      if (r.status !== 200) {
        throw new Error(describeError(r));
      }
      const meta = JSON.parse(r.headers?.['x-label-meta'] || '{}');
      const total = (meta.sizes || []).reduce((a, b) => a * b, 1);
      const onTop = saves.find(s => s.tag === meta.top);
      await this.onImportSegmentationFile(
        { name: `${saves.length} saves merged${onTop ? ` (${onTop.model || 'manual'} on top)` : ''}` },
        {
          fromServer: true,
          nid,
          mergedLayers: { seriesUID, saves, top: meta.top || null },
          loadedTags: saves.map(s => s.tag),
          loaded: {
            sizes: meta.sizes || [],
            keys: meta.keys || {},
            decode: (lut) => decodeLabelmap(r.data as ArrayBuffer, total, lut).data,
          },
        }
      );
    } catch (err) {
      this.notification.hide(nid);
      this.notification.show({
        title: 'MONAI Label',
        message: `Merging the saved segmentations failed: ${err?.message || err}`,
        type: 'error',
        duration: 8000,
      });
    }
  };

  // "Merged layers" box: puts another of the merged saves on top. Rebuilt from
  // the saves, so edits made since loading would be lost - ask first.
  onMergedTopChange = (tag) => {
    const merged = this.state.mergedLayers;
    if (!merged || merged.top === tag) {
      return;
    }
    if (
      annotationHistory.hasEdits() &&
      !window.confirm(
        'Changing which layer is on top reloads the merged saves, so your edits since loading ' +
          'them are lost (save first to keep them). Continue?'
      )
    ) {
      return;
    }
    this.loadMerged(merged.seriesUID, merged.saves, tag);
  };

  // Opens the list of this series' saves on the server (Load / Download /
  // Delete each), which also offers loading a .nrrd file from the computer.
  onClickLoadSegmentation = async (e) => {
    e?.preventDefault();
    const { displaySet } = this.getActiveViewportInfo();
    if (!displaySet) {
      return;
    }
    const seriesUID = displaySet.SeriesInstanceUID;
    const response = await this.client().list_labels(seriesUID);
    if (response.status !== 200) {
      // 404/500 here usually just means nothing was ever saved or run for this
      // series on the server yet - still offer loading from a file.
      console.warn('Could not list saved segmentations', response);
    }
    const saves: SavedSegmentation[] = (response.status === 200 ? response.data : [])
      .filter(({ tag }) => tag.startsWith('save-'))
      .map(({ tag, info }) => {
        const ms = Number(tag.slice('save-'.length));
        return {
          tag,
          model: info?.model,
          classes: info?.classes,
          savedAt: info?.saved_at ? new Date(info.saved_at) : Number.isFinite(ms) ? new Date(ms) : null,
        };
      })
      .sort((a, b) => (b.savedAt?.getTime() ?? 0) - (a.savedAt?.getTime() ?? 0));

    const fetchSave = async (save: SavedSegmentation) => {
      const r = await this.client().download_label(seriesUID, save.tag);
      if (r.status !== 200) {
        throw new Error(describeError(r));
      }
      return r.data as ArrayBuffer;
    };
    const name = (save: SavedSegmentation) => {
      const d = save.savedAt || new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return (
        `segmentation_${save.model || 'manual'}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}.nrrd`
      );
    };
    const failed = (what: string, err) =>
      this.notification.show({
        title: 'MONAI Label',
        message: `${what} failed: ${err?.message || err}`,
        type: 'error',
        duration: 8000,
      });

    const { uiDialogService } = this.props.servicesManager.services;
    const loadedTags = this.loadedSaves?.seriesUID === seriesUID ? this.loadedSaves.tags : [];
    loadSegmentationDialog(uiDialogService, saves, {
      onLoad: async save => {
        const nid = `load-${Date.now()}`;
        this.notification.show({ id: nid, title: 'MONAI Label', message: 'Loading segmentation...', type: 'loading' });
        try {
          // Run-length encoded by the server (lib/user_context.py), so the
          // browser never decompresses the whole volume itself.
          const r = await this.client().download_label_rle(seriesUID, save.tag);
          if (r.status !== 200) {
            throw new Error(describeError(r));
          }
          const meta = JSON.parse(r.headers?.['x-label-meta'] || '{}');
          const total = (meta.sizes || []).reduce((a, b) => a * b, 1);
          await this.onImportSegmentationFile(
            { name: `the save from ${save.savedAt?.toLocaleString() ?? save.tag}` },
            {
              fromServer: true,
              loadedTags: [save.tag],
              nid,
              loaded: {
                sizes: meta.sizes || [],
                keys: meta.keys || {},
                decode: (lut) => decodeLabelmap(r.data as ArrayBuffer, total, lut).data,
              },
            }
          );
        } catch (err) {
          this.notification.hide(nid);
          failed('Loading the segmentation', err);
        }
      },
      onLoadMerged: picked => this.loadMerged(seriesUID, picked, null),
      onDownload: async save => {
        try {
          const buffer = await fetchSave(save);
          const url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = name(save);
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (err) {
          failed('Downloading', err);
        }
      },
      onDelete: async save => {
        const r = await this.client().remove_label(seriesUID, save.tag);
        if (r.status !== 200) {
          failed('Deleting', describeError(r));
        } else {
          this.notification.show({ title: 'MONAI Label', message: 'Saved segmentation deleted', type: 'success', duration: 3000 });
        }
        this.onClickLoadSegmentation(null); // reopen with the updated list
      },
      onLoadFile: () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.nrrd';
        input.onchange = () => {
          const file = input.files?.[0];
          if (file) {
            const nid = `load-${Date.now()}`;
            this.notification.show({ id: nid, title: 'MONAI Label', message: 'Loading segmentation...', type: 'loading' });
            // let the toast paint before the file is read and decoded
            setTimeout(() => this.onImportSegmentationFile(file, { nid }), 50);
          }
        };
        input.click();
      },
    }, loadedTags);
  };

  // Loads a segmentation saved via saveToServer - from the server, or
  // a downloaded .nrrd on this or any other device. Also accepts a plain uint8
  // label NRRD without this tool's metadata (e.g. one written by another
  // tool, or a server save from before the header was added), in which case
  // voxel values are taken as this session's segment indices.
  // fromServer: it is already stored there, so don't save it again.
  // `loaded` (a save from the server - see onClickLoadSegmentation):
  // {sizes, keys, decode(lut)} with the voxels still run-length encoded, so
  // they're rebuilt and remapped in one pass of block fills. Without it, `file`
  // is a .nrrd from the computer, parsed here.
  // `nid`: id of a "Loading..." toast already showing - the result replaces it.
  onImportSegmentationFile = async (
    file,
    { fromServer = false, loaded = null, nid = null, mergedLayers = null, loadedTags = null } = {}
  ) => {
    const toast = { title: 'MONAI Label', ...(nid ? { id: nid } : {}) };
    const fail = (message) => this.notification.show({ ...toast, message, type: 'error', duration: 8000 });

    if (!loaded) {
      try {
        const ret = SegmentationReader.parseNrrdData(await file.arrayBuffer());
        const data = new Uint8Array(ret.image);
        loaded = {
          sizes: ret.header.sizes || [],
          keys: ret.header.keys || {},
          decode: (lut) => {
            const out = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
              out[i] = lut[data[i]];
            }
            return out;
          },
        };
      } catch (err) {
        console.error('Failed to parse loaded segmentation', err);
        fail(`${file.name} is not a readable NRRD segmentation file`);
        return;
      }
    }

    const { segmentationService } = this.props.servicesManager.services;
    await this.ensureSegmentation();
    const volumeLoadObject = this.labelmapVolume();
    const { displaySet } = this.getActiveViewportInfo();
    const sizes = loaded.sizes;
    const dims = volumeLoadObject?.dimensions || [];
    if (
      !volumeLoadObject?.voxelManager ||
      sizes.length !== dims.length ||
      sizes.some((s, i) => s !== dims[i])
    ) {
      fail(
        `${file.name} does not match the open image (file ${sizes.join('x') || '?'}, ` +
          `image ${dims.join('x') || '?'}) - open the series it was saved from`
      );
      return;
    }

    const keys = loaded.keys;
    if (
      keys.series_instance_uid &&
      displaySet &&
      keys.series_instance_uid !== displaySet.SeriesInstanceUID &&
      !window.confirm(
        `${file.name} was saved from a different series than the one open now. ` +
          'Its size matches, but the anatomy may not. Load it anyway?'
      )
    ) {
      if (nid) {
        this.notification.hide(nid);
      }
      return;
    }

    const { info } = currentSegmentsInfo(segmentationService);
    const lookup = new Uint8Array(256);
    const missing = [];
    let fileClasses = null;
    try {
      fileClasses = keys.classes ? JSON.parse(keys.classes) : null;
    } catch (err) {
      console.warn('Ignoring unreadable class list in loaded segmentation', err);
    }
    if (Array.isArray(fileClasses)) {
      for (const { name, index } of fileClasses) {
        const target = info[name]?.segmentIndex;
        if (target) {
          lookup[index] = target;
        } else {
          missing.push(name);
        }
      }
    } else {
      Object.values(info).forEach(({ segmentIndex }: any) => {
        lookup[segmentIndex] = segmentIndex;
      });
    }

    let remapped;
    try {
      remapped = loaded.decode(lookup);
    } catch (err) {
      console.error('Failed to decode loaded segmentation', err);
      fail(`${file.name} could not be read: ${err?.message || err}`);
      return;
    }

    // This is a wholesale state install, not a user edit - see
    // resetBaseline's own comment for why undo shouldn't be able to step
    // back past it to whatever segmentation existed before.
    annotationHistory.installState(() => writeLabelmap(volumeLoadObject, remapped), remapped);
    // The "Merged layers" box only applies to what was just merged.
    this.setState({ mergedLayers });
    this.loadedSaves = loadedTags && displaySet ? { seriesUID: displaySet.SeriesInstanceUID, tags: loadedTags } : null;
    if (keys.model) {
      // Later saves and Regional Stats then attribute this segmentation to
      // the model that originally produced it.
      this.lastUsedModel = keys.model;
    }

    // A file from the computer is stored on the server too, so it shows up
    // in the Load list and Regional Stats can use it.
    const synced = fromServer ? true : await this.saveToServer();

    const source = keys.model ? ` (model: ${keys.model})` : '';
    const problems = [
      missing.length ? `skipped classes this server has no model for: ${missing.join(', ')}` : '',
      synced ? '' : "storing it on the server failed, so it won't be in the Load list or Regional Stats",
    ].filter(Boolean);
    this.notification.show({
      ...toast,
      message: problems.length
        ? `Loaded ${file.name}${source}, but ${problems.join('; ')}`
        : `Loaded ${file.name}${source}`,
      type: problems.length ? 'warning' : 'success',
      duration: problems.length ? 10000 : 4000,
    });
  };

  resetSegmentation = () => {
    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = this.labelmapVolume();
    if (!volumeLoadObject) {
      return;
    }
    const [width, height, depth] = volumeLoadObject.dimensions || [];
    if (!depth) {
      return;
    }
    writeLabelmap(volumeLoadObject, new Uint8Array(width * height * depth));
  };

  render() {
    const { isDataReady } = this.state;
    return (
      <div className="monaiLabelPanel">
        <br style={{ margin: '3px' }} />

        <SettingsTable ref={this.settings} onInfo={this.onInfo} />
        {isDataReady && (
          <div style={{ color: 'white' }}>
            <p className="subtitle">{this.state.info.data.name}</p>
            <br />
            <hr className="separator" />
            <a
              href="#"
              onClick={this.openConfigurations}
              title="Options / Configurations"
              aria-label="Options / Configurations"
              className="headerIconLink"
            >
              <Icon name="icon-settings" width="20px" height="20px" />
            </a>
            <a
              href="#"
              onClick={this.onClickSaveSegmentation}
              title="Save Segmentation (on the server)"
              aria-label="Save Segmentation"
              className="headerIconLink"
            >
              <SaveIcon />
            </a>
            <a
              href="#"
              onClick={this.onClickLoadSegmentation}
              title="Load Segmentation (saved on the server, or a .nrrd file)"
              aria-label="Load Segmentation"
              className="headerIconLink"
            >
              <LoadIcon />
            </a>
            <hr className="separator" />
            {this.state.mergedLayers && (
              <div className="mergedLayers">
                <div className="mergedLayersTitle">Merged layers - on top:</div>
                {this.state.mergedLayers.saves.map(save => (
                  <label key={save.tag} className="mergedLayersRow">
                    <input
                      type="radio"
                      name="merged-top"
                      checked={this.state.mergedLayers.top === save.tag}
                      onChange={() => this.onMergedTopChange(save.tag)}
                    />
                    <span>{save.model || 'manual'}</span>
                    <span className="mergedLayersDate">
                      {save.savedAt ? save.savedAt.toLocaleString() : save.tag}
                    </span>
                  </label>
                ))}
                <hr className="separator" />
              </div>
            )}
          </div>
        )}
        {isDataReady && (
          <div className="tabs scrollbar" id="style-3">
            <ActiveLearning
              ref={this.actions['activelearning']}
              tabIndex={1}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              setBusy={(busy: boolean) => this.setBusy('activelearning', busy)}
              isBusy={!!this.state.busyActions['activelearning']}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
            />
            <Preprocessing
              ref={this.actions['preprocessing']}
              tabIndex={2}
              info={this.state.info}
              client={this.client}
              setBusy={(busy: boolean) => this.setBusy('preprocessing', busy)}
              isBusy={!!this.state.busyActions['preprocessing']}
              onSelectActionTab={this.onSelectActionTab}
              getActiveViewportInfo={this.getActiveViewportInfo}
            />
            <AutoSegmentation
              ref={this.actions['segmentation']}
              tabIndex={3}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              setBusy={(busy: boolean) => this.setBusy('segmentation', busy)}
              isBusy={!!this.state.busyActions['segmentation']}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
              onModelUsed={this.onModelUsed}
            />
            <SemiSegmentation
              ref={this.actions['semisegmentation']}
              tabIndex={4}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              setBusy={(busy: boolean) => this.setBusy('semisegmentation', busy)}
              isBusy={!!this.state.busyActions['semisegmentation']}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
              servicesManager={this.props.servicesManager}
              commandsManager={this.props.commandsManager}
              resetSegmentation={this.resetSegmentation}
              ensureSegmentation={this.ensureSegmentation}
              onModelUsed={this.onModelUsed}
            />
            <ClassPrompts
              ref={this.actions['classprompts']}
              tabIndex={5}
              info={this.state.info}
              client={this.client}
              updateView={this.updateView}
              setBusy={(busy: boolean) => this.setBusy('classprompts', busy)}
              isBusy={!!this.state.busyActions['classprompts']}
              onSelectActionTab={this.onSelectActionTab}
              onOptionsConfig={this.onOptionsConfig}
              getActiveViewportInfo={this.getActiveViewportInfo}
              servicesManager={this.props.servicesManager}
              commandsManager={this.props.commandsManager}
              onModelUsed={this.onModelUsed}
            />
            <RegionalStats
              ref={this.actions['regionalstats']}
              tabIndex={6}
              info={this.state.info}
              client={this.client}
              setBusy={(busy: boolean) => this.setBusy('regionalstats', busy)}
              isBusy={!!this.state.busyActions['regionalstats']}
              onSelectActionTab={this.onSelectActionTab}
              getActiveViewportInfo={this.getActiveViewportInfo}
              servicesManager={this.props.servicesManager}
            />
          </div>
        )}
      </div>
    );
  }
}
