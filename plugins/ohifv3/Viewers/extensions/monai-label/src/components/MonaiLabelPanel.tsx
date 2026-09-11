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
import { cache, triggerEvent, eventTarget } from '@cornerstonejs/core';
import SegmentationReader from '../utils/SegmentationReader';
import annotationHistory from '../utils/AnnotationHistory';
import { currentSegmentsInfo } from '../utils/SegUtils';
import SettingsTable from './SettingsTable';
import * as cornerstoneTools from '@cornerstonejs/tools';
import optionsInputDialog from './OptionsInputDialog';
import saveSegmentationDialog from './SaveSegmentationDialog';
import loadSegmentationDialog from './LoadSegmentationDialog';

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
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V3.4" />
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
    const volumeLoadObject = cache.getVolume('1');
    if (!volumeLoadObject) {
      this.props.commandsManager.runCommand('loadSegmentationsForViewport', {
        segmentations,
      });

      // Wait for Above Segmentations to be added/available
      setTimeout(() => {
        const { viewport } = this.getActiveViewportInfo();
        for (const segmentIndex of Object.keys(initialSegs)) {
          cornerstoneTools.segmentation.config.color.setSegmentIndexColor(
            viewport.viewportId,
            '1',
            initialSegs[segmentIndex].segmentIndex,
            initialSegs[segmentIndex].color
          );
        }
      }, 1000);
    }

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
    const ret = SegmentationReader.parseNrrdData(response.data);
    if (!ret) {
      throw new Error('Failed to parse NRRD data');
    }

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
    const data = new Uint8Array(ret.image);

    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    if (volumeLoadObject) {
      // console.log('Volume Object is In Cache....');
      let convertedData = data;
      for (let i = 0; i < convertedData.length; i++) {
        const midx = convertedData[i];
        const sidx = modelToSegMapping[midx];
        if (midx && sidx) {
          convertedData[i] = sidx;
        } else if (override && label_class_unknown && labels.length === 1) {
          convertedData[i] = midx ? labelNames[labels[0]] : 0;
        } else if (labels.length > 0) {
          convertedData[i] = 0;
        }
      }

      if (override === true) {
        const { segmentationService } = this.props.servicesManager.services;
        const volumeLoadObject = segmentationService.getLabelmapVolume('1');
        const { voxelManager } = volumeLoadObject;
        const scalarData = voxelManager?.getCompleteScalarDataArray();

        // console.log('Current ScalarData: ', scalarData);
        const currentSegArray = new Uint8Array(scalarData.length);
        currentSegArray.set(scalarData);

        const numImageFrames =
          this.getActiveViewportInfo().displaySet.numImageFrames;
        const sliceLength = scalarData.length / numImageFrames;
        const sliceBegin = sliceLength * sidx;
        const sliceEnd = sliceBegin + sliceLength;
        const [width] = volumeLoadObject.dimensions || [];
        console.log('xyBounds merge check: ', { xyBounds, mode, dimensions: volumeLoadObject.dimensions, width });

        // xyBounds.zmin/zmax (SAM2 runs only - see SemiSegmentation.tsx's
        // SAM2_MAX_FRAMES_TO_TRACK) restrict the merge to the slice range
        // that model actually tracked. Without this, a voxel on some
        // unrelated slice that just happens to share this run's (x,y) box
        // reads as "the model decided 0 here" and gets overwritten, when
        // really the model never looked at that slice at all - its result
        // array there is just a zero-filled placeholder.
        const isOutsideBounds = (i) => {
          if (!xyBounds || !width) {
            return false;
          }
          const local = i % sliceLength;
          const x = local % width;
          const y = Math.floor(local / width);
          const frameIdx = Math.floor(i / sliceLength);
          return (
            x < xyBounds.xmin ||
            x > xyBounds.xmax ||
            y < xyBounds.ymin ||
            y > xyBounds.ymax ||
            (xyBounds.zmin != null && frameIdx < xyBounds.zmin) ||
            (xyBounds.zmax != null && frameIdx > xyBounds.zmax)
          );
        };

        if (mode === 'remove') {
          // Brush-erase propagation: convertedData is nonzero wherever the
          // model tracked the erased region onto this slice. Clear exactly
          // those voxels, and only if they're currently this same class -
          // every other in-bounds voxel (untracked, or a different class)
          // is left untouched. This deliberately doesn't reuse the 'add'
          // merge below: that treats "response says 0 here" as "write 0",
          // which for a remove-propagated mask would wipe every unrelated
          // 0/background voxel in the whole padded box instead of just the
          // specific tracked region.
          let cleared = 0;
          for (let i = 0; i < convertedData.length; i++) {
            if (sidx >= 0 && (i < sliceBegin || i >= sliceEnd)) {
              continue;
            }
            if (isOutsideBounds(i)) {
              continue;
            }
            if (convertedData[i] !== 0 && currentSegArray[i] === convertedData[i]) {
              currentSegArray[i] = 0;
              cleared++;
            }
          }
          console.log('remove-mode merge: ', { cleared });
        } else if (mode === 'add-brush') {
          // Brush-add propagation: convertedData is nonzero wherever the
          // model tracked the newly painted region onto this slice. Only
          // ADD those voxels in as this class - never clear anything to 0,
          // unlike the plain 'add' branch below, which treats "response
          // says 0 here" as "write 0" (correcting the box). That's right
          // for a fresh ROI prompt, but here it would wipe out unrelated,
          // untouched same-class mask that just happens to fall inside the
          // padded margin/z-range around the brush stroke.
          let added = 0;
          for (let i = 0; i < convertedData.length; i++) {
            if (sidx >= 0 && (i < sliceBegin || i >= sliceEnd)) {
              continue;
            }
            if (isOutsideBounds(i)) {
              continue;
            }
            if (convertedData[i] !== 0) {
              currentSegArray[i] = convertedData[i];
              added++;
            }
          }
          console.log('add-brush merge: ', { added });
        } else {
          // get unique values to determine which organs to update, keep rest
          const updateTargets = new Set(convertedData);

          let nonZeroOutsideBefore = 0;
          if (xyBounds && width) {
            for (let i = 0; i < scalarData.length; i++) {
              if (scalarData[i] === 0) continue;
              if (isOutsideBounds(i)) {
                nonZeroOutsideBefore++;
              }
            }
          }
          window.__debugOverwrites = 0;

          for (let i = 0; i < convertedData.length; i++) {
            if (sidx >= 0 && (i < sliceBegin || i >= sliceEnd)) {
              continue;
            }

            if (isOutsideBounds(i)) {
              continue;
            }

            if (
              convertedData[i] !== 255 &&
              updateTargets.has(currentSegArray[i])
            ) {
              if (currentSegArray[i] !== 0) {
                window.__debugOverwrites = (window.__debugOverwrites || 0) + 1;
              }
              currentSegArray[i] = convertedData[i];
            }
          }
          let nonZeroOutsideAfter = 0;
          if (xyBounds && width) {
            for (let i = 0; i < currentSegArray.length; i++) {
              if (currentSegArray[i] === 0) continue;
              if (isOutsideBounds(i)) {
                nonZeroOutsideAfter++;
              }
            }
          }
          console.log('outside-xyBounds preservation check: ', {
            nonZeroOutsideBefore,
            nonZeroOutsideAfter,
            overwritesInsideBounds: window.__debugOverwrites,
          });
        }

        convertedData = currentSegArray;
      }
      const { voxelManager } = volumeLoadObject;
      voxelManager?.setCompleteScalarDataArray(convertedData);
      triggerEvent(eventTarget, Enums.Events.SEGMENTATION_DATA_MODIFIED, {
        segmentationId: '1',
      });
      console.log("updated the segmentation's scalar data");
    } else {
      console.log('TODO:: Volume Object is NOT In Cache....');
    }
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
    if (this.state.isDataReady) {
      return;
    }

    console.log('(Component Mounted) Ready to Connect to MONAI Server...');
    // await this.onInfo();
  }

  onOptionsConfig = () => {
    return this.state.options;
  };

  // Saving is manual-only now (see onClickSaveSegmentation) - each save
  // gets its own 'save-<timestamp>' tag (rather than always overwriting a
  // single 'final' label), carrying model/classes/timestamp metadata so
  // the Load Segmentation picker can show the user what they're choosing
  // between.
  onSaveSegmentation = async (classes) => {
    try {
      const { segmentationService } = this.props.servicesManager.services;
      const volumeLoadObject = segmentationService.getLabelmapVolume('1');
      const scalarData = volumeLoadObject?.voxelManager?.getCompleteScalarDataArray();
      if (!scalarData) {
        return false;
      }

      const { displaySet } = this.getActiveViewportInfo();
      if (!displaySet) {
        return false;
      }

      const nrrdBuffer = SegmentationReader.writeNrrdData(new Uint8Array(scalarData), {
        sizes: volumeLoadObject.dimensions,
        direction: volumeLoadObject.direction,
        spacing: volumeLoadObject.spacing,
        origin: volumeLoadObject.origin,
      });

      const tag = `save-${Date.now()}`;
      const response = await this.client().save_label(
        displaySet.SeriesInstanceUID,
        new Blob([nrrdBuffer]),
        { model: this.lastUsedModel, classes },
        tag
      );

      if (response.status !== 200) {
        console.error('Failed to save segmentation', response);
        this.notification.show({
          title: 'MONAI Label',
          message: `Failed to save segmentation: ${describeError(response)}`,
          type: 'error',
          duration: 8000,
        });
        return false;
      }

      this.notification.show({
        title: 'MONAI Label',
        message: 'Segmentation saved',
        type: 'success',
        duration: 3000,
      });
      return true;
    } catch (e) {
      console.error('Failed to save segmentation', e);
      this.notification.show({
        title: 'MONAI Label',
        message: `Failed to save segmentation: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
      return false;
    }
  };

  // Auto-fills the confirm dialog from the current segmentation state:
  // whichever model most recently ran (onModelUsed), and whichever classes
  // actually have voxels right now (not just whatever's in the global
  // label list, most of which are usually unpainted).
  onClickSaveSegmentation = (e) => {
    e.preventDefault();

    const { segmentationService, uiDialogService } = this.props.servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    const scalarData = volumeLoadObject?.voxelManager?.getCompleteScalarDataArray();
    if (!scalarData) {
      this.notification.show({
        title: 'MONAI Label',
        message: 'Nothing to save yet',
        type: 'warning',
        duration: 4000,
      });
      return;
    }

    const presentIndices = new Set();
    for (let i = 0; i < scalarData.length; i++) {
      if (scalarData[i]) {
        presentIndices.add(scalarData[i]);
      }
    }

    const { info } = currentSegmentsInfo(segmentationService);
    const classes = Object.keys(info)
      .filter((name) => presentIndices.has(info[name].segmentIndex))
      .sort((a, b) => info[a].segmentIndex - info[b].segmentIndex);

    saveSegmentationDialog(uiDialogService, { model: this.lastUsedModel, classes }, () => {
      this.onSaveSegmentation(classes);
    });
  };

  // Lists this image's saves and opens the picker (see LoadSegmentationDialog);
  // the actual voxel install only happens once the user picks a save AND
  // confirms it in the details modal (onLoadSegmentation).
  onClickLoadSegmentation = async (e) => {
    e.preventDefault();

    const { displaySet } = this.getActiveViewportInfo();
    if (!displaySet) {
      return;
    }

    const response = await this.client().list_labels(displaySet.SeriesInstanceUID);
    if (!response || response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label',
        message: `Failed to list saved segmentations: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
      return;
    }

    const saves = (response.data || [])
      .filter((save) => save.tag && save.tag.startsWith('save-'))
      .sort((a, b) => (b.info?.ts || 0) - (a.info?.ts || 0));

    const { uiDialogService } = this.props.servicesManager.services;
    loadSegmentationDialog(
      uiDialogService,
      saves,
      (tag) => {
        this.onLoadSegmentation(displaySet.SeriesInstanceUID, tag);
      },
      (save) => this.onDeleteSavedSegmentation(displaySet.SeriesInstanceUID, save)
    );
  };

  // Backing action for the trash icon in the Load Segmentation list -
  // returns whether the delete actually succeeded so the dialog only drops
  // the row from its list once the backend confirms it's gone.
  onDeleteSavedSegmentation = async (image, save) => {
    const response = await this.client().remove_label(image, save.tag);
    if (!response || response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label',
        message: `Failed to delete saved segmentation: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
      return false;
    }
    this.notification.show({
      title: 'MONAI Label',
      message: 'Saved segmentation deleted',
      type: 'success',
      duration: 3000,
    });
    return true;
  };

  onLoadSegmentation = async (image, tag) => {
    const response = await this.client().get_label(image, tag);
    if (!response || response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label',
        message: `Failed to load segmentation: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
      return;
    }

    const ret = SegmentationReader.parseNrrdData(response.data);
    if (!ret) {
      this.notification.show({
        title: 'MONAI Label',
        message: 'Saved segmentation could not be parsed',
        type: 'error',
        duration: 8000,
      });
      return;
    }

    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    const scalarData = volumeLoadObject?.voxelManager?.getCompleteScalarDataArray();
    const data = new Uint8Array(ret.image);
    if (!scalarData || data.length !== scalarData.length) {
      // Most likely the saved file is from a differently-sized image (or a
      // stale/incompatible save) - installing it anyway would silently
      // corrupt the current volume.
      console.warn('Saved segmentation size mismatch - skipping load', {
        savedLength: data.length,
        expectedLength: scalarData?.length,
      });
      this.notification.show({
        title: 'MONAI Label',
        message: 'Saved segmentation does not match the current image - skipped',
        type: 'error',
        duration: 8000,
      });
      return;
    }

    volumeLoadObject.voxelManager.setCompleteScalarDataArray(data);
    triggerEvent(eventTarget, Enums.Events.SEGMENTATION_DATA_MODIFIED, {
      segmentationId: '1',
    });
    // This is a wholesale state install, not a user edit - see
    // resetBaseline's own comment for why undo shouldn't be able to step
    // back past it to whatever segmentation existed before.
    annotationHistory.resetBaseline();
    this.notification.show({
      title: 'MONAI Label',
      message: 'Loaded saved segmentation',
      type: 'success',
      duration: 4000,
    });
  };

  resetSegmentation = () => {
    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    if (!volumeLoadObject) {
      return;
    }
    const { voxelManager } = volumeLoadObject;
    const scalarData = voxelManager?.getCompleteScalarDataArray();
    if (!scalarData) {
      return;
    }
    voxelManager.setCompleteScalarDataArray(new Uint8Array(scalarData.length));
    triggerEvent(eventTarget, Enums.Events.SEGMENTATION_DATA_MODIFIED, {
      segmentationId: '1',
    });
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
              title="Save Segmentation"
              aria-label="Save Segmentation"
              className="headerIconLink"
            >
              <SaveIcon />
            </a>
            <a
              href="#"
              onClick={this.onClickLoadSegmentation}
              title="Load Segmentation"
              aria-label="Load Segmentation"
              className="headerIconLink"
            >
              <LoadIcon />
            </a>
            <hr className="separator" />
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
            <AutoSegmentation
              ref={this.actions['segmentation']}
              tabIndex={2}
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
              tabIndex={3}
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
              onModelUsed={this.onModelUsed}
            />
            <ClassPrompts
              ref={this.actions['classprompts']}
              tabIndex={4}
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
              tabIndex={5}
              info={this.state.info}
              client={this.client}
              setBusy={(busy: boolean) => this.setBusy('regionalstats', busy)}
              isBusy={!!this.state.busyActions['regionalstats']}
              onSelectActionTab={this.onSelectActionTab}
              getActiveViewportInfo={this.getActiveViewportInfo}
            />
            <Preprocessing
              ref={this.actions['preprocessing']}
              tabIndex={6}
              info={this.state.info}
              client={this.client}
              setBusy={(busy: boolean) => this.setBusy('preprocessing', busy)}
              isBusy={!!this.state.busyActions['preprocessing']}
              onSelectActionTab={this.onSelectActionTab}
              getActiveViewportInfo={this.getActiveViewportInfo}
            />
          </div>
        )}
      </div>
    );
  }
}
