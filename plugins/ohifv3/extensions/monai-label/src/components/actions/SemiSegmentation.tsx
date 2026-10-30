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

import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Icon } from '@ohif/ui';
import ModelSelector from '../ModelSelector';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { getEnabledElements } from '@cornerstonejs/core';
import { useActionTab, ActionTabProps } from './useActionTab';
import { hideNotification, describeError } from '../../utils/GenericUtils';
import { renderAllViewports } from '../../utils/AnnotationHistory';

const SHAPE_TOOLS = {
  point: 'ProbeMONAILabel',
  rectangle: 'RectangleROI',
  freehand: 'PlanarFreehandROI',
  // CircularBrush/CircularEraser are cornerstone3D's own labelmap-editing
  // tools (already registered passively in initToolGroups.js for the
  // segmentation toolbox) - reused here rather than built from scratch,
  // since exclude/add for a brush is exactly their existing fill/erase
  // strategy pair.
  brush: 'CircularBrush',
};

// Exclude is a mode, not a fourth shape: it swaps whichever shape tool is
// active for its "exclude" counterpart, so the same point/box/freehand
// interactions draw a region to remove instead of a region to add.
const EXCLUDE_SHAPE_TOOLS = {
  point: 'ProbeMONAILabelExclude',
  rectangle: 'RectangleROIExclude',
  freehand: 'PlanarFreehandROIExclude',
  brush: 'CircularEraser',
};

// Half-width of the local neighborhood a point prompt expands to, matching
// nnU-Net's own XY_MIN_SIZE=96 padding (radiology/lib/infers/nnunet.py) -
// keep these in sync, this only affects which merge region gets protected
// on the frontend, not what the backend actually crops/classifies.
const POINT_NEIGHBORHOOD_RADIUS = 48;

// Mirrors sam2_interactive.py's MAX_FRAMES_TO_TRACK. SAM2 only ever writes
// (or genuinely decides) anything within this many slices of the prompted
// slice - everywhere else its result array is just a zero-filled
// placeholder that was never inferenced, not an actual "not this class"
// decision. The merge in updateView can't tell those apart on its own, so
// runs against the SAM2 model attach a z range here to keep it from
// overwriting real earlier labels on slices SAM2 never looked at. nnU-Net's
// rectangle/freehand path is deliberately left z-unbounded (see
// nnunet.py's _roi_to_bbox) since its result IS a real full-depth
// classification, not a placeholder.
const SAM2_MAX_FRAMES_TO_TRACK = 60;

// Mirrors sam2_interactive.py's BRUSH_PATCH_MARGIN - a brush stroke is
// already pixel-exact, so this only needs enough room for SAM2 to
// refine/shift slightly slice to slice, not to grow an outline.
const BRUSH_NEIGHBORHOOD_MARGIN = 24;

// Half of nnunet.py's Z_MIN_SIZE - a point's hull is grown from local pixel
// similarity on ONE slice, so (unlike a hand-drawn rectangle/freehand ROI,
// which nnU-Net deliberately classifies through the whole study depth)
// nnU-Net only ever classifies a small z window around that slice for a
// point prompt. Without a matching z bound here, the merge would read every
// slice outside that window - never actually inferenced, just a zero-filled
// placeholder - as "nnU-Net decided background here" and wipe out real,
// unrelated segmentation from earlier runs on those slices.
const POINT_Z_MARGIN = 32;

// Matches initToolGroups.js's own CircularBrush/CircularEraser default -
// this is just the initial value the slider starts at; the tool's actual
// configured size always tracks brushSize state once the component mounts.
const DEFAULT_BRUSH_SIZE = 5;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 20;

const UndoIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
);

const RedoIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </svg>
);

const ExcludeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <line x1="7" y1="12" x2="17" y2="12" />
  </svg>
);

const ResetIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

// --- Pure helpers (no props/state - hoisted out of the component so they
// aren't recreated every render) ---

function toolNameFor(shape, excludeMode) {
  return excludeMode ? EXCLUDE_SHAPE_TOOLS[shape] : SHAPE_TOOLS[shape];
}

function segColorToRgb(s) {
  const c = s ? s.color : [0, 0, 0];
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// {xmin, ymin, xmax, ymax} of a list of [x, y, ...] points - every prompt
// builder below needs this same bounding box (of a point's neighborhood, a
// rectangle's corners, a freehand outline's vertices, or a brush stroke's
// touched pixels), so it's computed in one place instead of being
// re-derived slightly differently at each call site.
function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    xmin: Math.min(...xs),
    ymin: Math.min(...ys),
    xmax: Math.max(...xs),
    ymax: Math.max(...ys),
  };
}

function getModels(info) {
  // Both prompt-driven models belong here: 'deepgrow' (SAM2 - genuine
  // object-mask tracing, single class per run) and 'segmentation' (nnU-Net -
  // classifies the prompted region into all classes at once). Same
  // type-based filtering AutoSegmentation.tsx uses for its own list.
  return Object.keys(info.data.models).filter(
    (m) =>
      info.data.models[m].type === 'deepgrow' ||
      info.data.models[m].type === 'segmentation'
  );
}

function isSam2Model(info, model) {
  return model && info.data.models[model]?.type === 'deepgrow';
}

function getModelLabels(info, model) {
  const names = (model && info.modelLabelNames[model]) || [];
  return names.filter((name) => name !== 'background');
}

function forEachFrameOfReference(fn) {
  const seen = new Set();
  getEnabledElements().forEach((el) => {
    const forUID = el?.FrameOfReferenceUID;
    if (forUID && !seen.has(forUID)) {
      seen.add(forUID);
      fn(forUID);
    }
  });
}

function clearPointAnnotations() {
  forEachFrameOfReference((forUID) =>
    cornerstoneTools.annotation.state.removeAnnotations('ProbeMONAILabel', forUID)
  );
  renderAllViewports();
}

// Same "consumed once used" reasoning as clearPointAnnotations - an exclude
// shape is a one-shot correction to whatever run it was attached to, not a
// standing marker.
function clearExcludeAnnotations() {
  forEachFrameOfReference((forUID) => {
    Object.values(EXCLUDE_SHAPE_TOOLS).forEach((toolName) => {
      cornerstoneTools.annotation.state.removeAnnotations(toolName, forUID);
    });
  });
  renderAllViewports();
}

const SemiSegmentation = forwardRef<any, ActionTabProps>((props, ref) => {
  const {
    info,
    isBusy,
    setBusy,
    updateView,
    onOptionsConfig,
    getActiveViewportInfo,
    servicesManager,
    commandsManager,
    resetSegmentation,
    onModelUsed,
  } = props;
  const { notification, tabId, resolveModel, segmentInfo, onSelectActionTab } = useActionTab(props);

  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [currentShape, setCurrentShape] = useState('point');
  const [currentLabel, setCurrentLabel] = useState<string | null>(null);
  const [excludeMode, setExcludeMode] = useState(false);
  // Baseline for the brush tool's before/after diff (see snapshotBrush and
  // buildBrushParamsList) - null means no brush edits are pending.
  const [brushSnapshot, setBrushSnapshot] = useState<any>(null);
  // Radius (mm) CircularBrush/CircularEraser paint/erase with - see
  // onBrushSizeChange/applyBrushSize.
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);

  // Pushes the given radius (mm) onto both CircularBrush and CircularEraser
  // in the active viewport's tool group - both, always, regardless of which
  // one (paint vs erase) is currently active, so switching Exclude on/off
  // never leaves the two tools at different sizes.
  const applyBrushSize = (size: number) => {
    const { toolGroupService } = servicesManager?.services || {};
    const toolGroup = toolGroupService?.getToolGroup();
    if (!toolGroup) {
      return;
    }
    cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(toolGroup.id, size);
  };

  useEffect(() => {
    // initToolGroups.js sets the tools' own default at registration time,
    // before this component (or its state) exists - push this component's
    // default onto them explicitly so the slider's starting position and
    // the tool's actual size are never out of sync.
    applyBrushSize(brushSize);
    // Mount-only, matching the old componentDidMount - onBrushSizeChange and
    // onSelectShape's brush-entry already re-apply this whenever it matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disables one cornerstone tool and activates another - every caller that
  // swaps tools (picking a new shape, toggling exclude mode) needs exactly
  // this pair of commands in exactly this order, so it's centralized here
  // rather than repeated inline at each call site.
  const switchTool = (fromToolName: string, toToolName: string) => {
    commandsManager.runCommand('setToolDisable', { toolName: fromToolName });
    commandsManager.runCommand('setToolActive', { toolName: toToolName });
  };

  const getWorldToIndex = () => {
    const { viewport } = getActiveViewportInfo();
    const { cornerstoneViewportService } = servicesManager.services;
    const viewportInfo = cornerstoneViewportService.getViewportInfo(viewport.viewportId);
    return viewportInfo.viewportData.data[0].volume.imageData.worldToIndex;
  };

  const getElement = () => {
    const { viewport } = getActiveViewportInfo();
    const { cornerstoneViewportService } = servicesManager.services;
    return cornerstoneViewportService.getCornerstoneViewport(viewport.viewportId).element;
  };

  // Whole volume's worth of "is this voxel currently segIndex" - used both
  // to snapshot the brush baseline and, at Run time, to read back the
  // current state for diffing against it. Deliberately not scoped to "the
  // current slice": the user can pick the brush tool/class on one slice and
  // then scroll before actually painting, so pinning a slice index up front
  // at snapshot time can end up diffing a slice nothing ever touched.
  // Scanning the whole volume finds whichever slice(s) actually changed
  // instead.
  const readClassVolumeMask = (segIndex: number) => {
    const { segmentationService } = servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    const [width] = volumeLoadObject?.dimensions || [];
    const scalarData = volumeLoadObject?.voxelManager?.getCompleteScalarDataArray();
    if (!scalarData || !width) {
      return null;
    }
    const numImageFrames = getActiveViewportInfo().displaySet.numImageFrames;
    const sliceLength = scalarData.length / numImageFrames;
    const mask = new Uint8Array(scalarData.length);
    for (let i = 0; i < scalarData.length; i++) {
      mask[i] = scalarData[i] === segIndex ? 1 : 0;
    }
    return { mask, width, sliceLength };
  };

  // CircularBrush/CircularEraser otherwise touch whatever class's voxels
  // happen to be under the circle, not just the one currently selected -
  // cornerstone3D's fill/erase strategies already skip any segment index
  // present in this list (used for its own "locked segment" feature), so
  // locking every class except the active one is what keeps a paint or
  // erase stroke scoped to just that class, leaving anything else already
  // labeled there untouched either way.
  const activateBrushSegment = (segIndex: number) => {
    cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex('1', segIndex);
    Object.values(segmentInfo()).forEach(({ segmentIndex: otherIndex }: any) => {
      try {
        cornerstoneTools.segmentation.segmentLocking.setSegmentIndexLocked(
          '1',
          otherIndex,
          otherIndex !== segIndex
        );
      } catch (e) {
        // Segment not yet registered in cornerstone3D's own segmentation
        // state (still just an OHIF-level entry) - nothing to lock yet.
      }
    });
  };

  // Undoes activateBrushSegment's locks - they only make sense while the
  // brush is the active tool, and left in place they'd silently block every
  // other class from being painted/erased by any later brush stroke.
  const unlockAllSegments = () => {
    Object.values(segmentInfo()).forEach(({ segmentIndex }: any) => {
      try {
        cornerstoneTools.segmentation.segmentLocking.setSegmentIndexLocked('1', segmentIndex, false);
      } catch (e) {
        // Not registered in cornerstone3D's segmentation state yet - nothing to unlock.
      }
    });
  };

  // Points the brush at the given class: keeps the pending baseline if it
  // already belongs to that class (so a not-yet-sent edit isn't discarded),
  // otherwise arms a fresh one. Must run whenever the brush becomes active or
  // the class changes - a baseline left over from an earlier brush session
  // keeps that OLD class active and every other class (including the one
  // now ticked) locked, so painting/erasing the ticked class does nothing.
  const armBrush = (label: string | null) => {
    const segIndex = label && segmentInfo()[label]?.segmentIndex;
    if (brushSnapshot && segIndex != null && brushSnapshot.segIndex === segIndex) {
      activateBrushSegment(segIndex);
      return;
    }
    snapshotBrush(label);
  };

  // Arms a fresh brush baseline: the current state of the given class
  // across the whole volume. Also points CircularBrush/CircularEraser at
  // that class's segment index, so painting actually edits it rather than
  // whichever segment was last active. Called on entering brush mode and on
  // picking/changing the class while already in it - but NOT if doing so
  // would just re-baseline against a not-yet-sent edit for the exact same
  // class (see onSelectShape/onSelectLabel), which would silently discard
  // it. Takes the label explicitly rather than reading currentLabel state,
  // since callers (onSelectLabel) need to snapshot against the class the
  // user JUST picked, before that state update has actually re-rendered.
  const snapshotBrush = (label: string | null) => {
    const segIndex = label && segmentInfo()[label]?.segmentIndex;
    if (segIndex == null) {
      setBrushSnapshot(null);
      return;
    }
    activateBrushSegment(segIndex);
    const snapshot = readClassVolumeMask(segIndex);
    setBrushSnapshot(snapshot ? { segIndex, ...snapshot } : null);
  };

  // Reads live annotations directly instead of AnnotationManager.saveAnnotations(),
  // which structuredClone()s the whole state - PlanarFreehandROI annotations carry
  // a non-cloneable onInterpolationComplete callback (attached by cornerstone
  // itself), which throws a DataCloneError as soon as any freehand ROI exists.
  const getToolAnnotations = (toolName: string) =>
    cornerstoneTools.annotation.state.getAnnotations(toolName, getElement());

  // Points are seeds for ONE shared region, not independent prompts: the
  // backend grows a real, edge-aware region from them (graph-based region
  // growing, not a shape that just connects the clicks), so every current
  // point annotation combines into a single prompt here - unlike the
  // rectangle/freehand builders below, which batch one prompt per shape.
  const buildPointParamsList = () => {
    const worldToIndex = getWorldToIndex();
    const annotations = getToolAnnotations('ProbeMONAILabel');
    if (!annotations.length) {
      return [];
    }

    const points = annotations.map((annotation) =>
      worldToIndex(annotation.data.handles.points[0]).map(Math.round)
    );
    // Padded bounding box around all points - a safe upper bound for the
    // merge-protection region regardless of whether the backend ends up
    // tracing a hull (which stays within this box) or falling back to a
    // small local neighborhood for <3 points.
    const { xmin, ymin, xmax, ymax } = boundsOf(points);
    return [
      {
        kind: 'point',
        params: { foreground: points },
        xyBounds: {
          xmin: xmin - POINT_NEIGHBORHOOD_RADIUS,
          ymin: ymin - POINT_NEIGHBORHOOD_RADIUS,
          xmax: xmax + POINT_NEIGHBORHOOD_RADIUS,
          ymax: ymax + POINT_NEIGHBORHOOD_RADIUS,
        },
        // points[0][2]: same "points share one key slice" assumption the
        // backend already makes for this prompt (nnunet.py/sam2_interactive.py
        // both key off foreground[0]'s z).
        z: points[0][2],
      },
    ];
  };

  // A box prompt is inherently a single box, so every rectangle currently in
  // the viewport (old ones aren't auto-cleared) becomes its own separate
  // prompt/run here - drawing several boxes then hitting Run once processes
  // all of them, instead of silently unioning them into one giant box or
  // only acting on whichever was drawn most recently.
  const buildRectangleParamsList = () => {
    const worldToIndex = getWorldToIndex();
    const annotations = getToolAnnotations('RectangleROI');

    return annotations.map((annotation) => {
      const corners = annotation.data.handles.points.map((pt) => worldToIndex(pt).map(Math.round));
      const z = corners[0][2];
      const { xmin, ymin, xmax, ymax } = boundsOf(corners);
      return {
        params: { roi: { start: [xmin, ymin, z], end: [xmax, ymax, z] } },
        xyBounds: { xmin, ymin, xmax, ymax },
        z,
      };
    });
  };

  // Same reasoning as buildRectangleParamsList: one drawn polygon = one prompt.
  const buildFreehandParamsList = () => {
    const worldToIndex = getWorldToIndex();
    const annotations = getToolAnnotations('PlanarFreehandROI');

    return annotations.map((annotation) => {
      const vertices = annotation.data.contour.polyline.map((pt) => worldToIndex(pt).map(Math.round));
      const z = vertices[0][2];
      return {
        params: {
          mask_polygon: vertices.map((p) => [p[0], p[1]]),
          roi_slice: z,
        },
        xyBounds: boundsOf(vertices),
        z,
      };
    });
  };

  // CircularBrush/CircularEraser edit the segmentation directly, so there's
  // no annotation to build a prompt from - instead this diffs the current
  // whole-volume state of the snapshotted class (see snapshotBrush) against
  // that baseline, then groups whatever changed by slice (the user may have
  // scrolled and painted on more than one since the last snapshot/Run).
  // Painted-in pixels become one 'add-brush' prompt (mode below) covering
  // every touched slice, erased pixels become one 'remove' prompt the same
  // way (see updateView's mode param) - NOT one prompt per slice: SAM2's
  // video predictor already supports adding several frames' exact masks to
  // the same tracking pass before propagating, so batching them into a
  // single request (see sam2_interactive.py's _propagate_multi) avoids
  // running a whole separate forward+backward propagation per slice, whose
  // tracked windows (MAX_FRAMES_TO_TRACK) mostly re-cover each other anyway
  // when the touched slices are close together. 'add-brush' is deliberately
  // its own mode, distinct from the plain 'add' that point/rectangle/
  // freehand ROI prompts use: those are meant to replace whatever's in their
  // drawn box (so the model can also correct/clear an existing bad mask
  // there), but a brush stroke is a deliberate, already-correct edit -
  // propagating it should only ADD the tracked voxels, never let SAM2's
  // padded margin clear other, unrelated same-class mask nearby that was
  // never touched by the brush.
  const buildBrushParamsList = () => {
    if (!brushSnapshot) {
      return [];
    }
    const { segIndex, mask: before, width, sliceLength } = brushSnapshot;
    const after = readClassVolumeMask(segIndex);
    if (!after || after.width !== width || after.sliceLength !== sliceLength) {
      return [];
    }

    const addedBySlice = new Map();
    const removedBySlice = new Map();
    for (let i = 0; i < after.mask.length; i++) {
      if (after.mask[i] === before[i]) {
        continue;
      }
      const sliceIndex = Math.floor(i / sliceLength);
      const local = i % sliceLength;
      const pixel = [local % width, Math.floor(local / width)];
      const bySlice = after.mask[i] ? addedBySlice : removedBySlice;
      if (!bySlice.has(sliceIndex)) {
        bySlice.set(sliceIndex, []);
      }
      bySlice.get(sliceIndex).push(pixel);
    }

    // One prompt per mode, carrying every touched slice's own mask -
    // xyBounds/zMin/zMax cover the union of all of them (see onRunInference,
    // which pads zMin/zMax by SAM2_MAX_FRAMES_TO_TRACK on each end the same
    // way it already does for a single-slice z).
    const toPrompt = (bySlice, mode) => {
      const sliceIndices = Array.from(bySlice.keys()).map(Number);
      const allPixels = sliceIndices.flatMap((sliceIndex) => bySlice.get(sliceIndex));
      const { xmin, ymin, xmax, ymax } = boundsOf(allPixels);
      return {
        kind: 'brush',
        mode,
        params: {
          brush_masks: sliceIndices.map((sliceIndex) => ({
            roi_slice: sliceIndex,
            brush_mask: bySlice.get(sliceIndex),
          })),
        },
        xyBounds: {
          xmin: xmin - BRUSH_NEIGHBORHOOD_MARGIN,
          ymin: ymin - BRUSH_NEIGHBORHOOD_MARGIN,
          xmax: xmax + BRUSH_NEIGHBORHOOD_MARGIN,
          ymax: ymax + BRUSH_NEIGHBORHOOD_MARGIN,
        },
        zMin: Math.min(...sliceIndices),
        zMax: Math.max(...sliceIndices),
      };
    };

    const prompts = [];
    if (addedBySlice.size) {
      prompts.push(toPrompt(addedBySlice, 'add-brush'));
    }
    if (removedBySlice.size) {
      prompts.push(toPrompt(removedBySlice, 'remove'));
    }
    return prompts;
  };

  // Exclude shapes (drawn in exclude mode - see onToggleExclude) aren't a
  // prompt of their own: they carve a region back out of whatever this
  // run's other prompt(s) produce, so they get attached to every prompt
  // built above rather than treated as an independent entry in that list.
  // Returns the shapes (for the generic post-hoc cut, every model/prompt
  // type) plus the point-only subset (for SAM2's own native negative-point
  // input, which only understands points, not boxes/polygons).
  const buildExcludeShapes = () => {
    const worldToIndex = getWorldToIndex();
    const shapes = [];
    const points = [];

    for (const annotation of getToolAnnotations('ProbeMONAILabelExclude')) {
      const [x, y, z] = worldToIndex(annotation.data.handles.points[0]).map(Math.round);
      shapes.push({ type: 'point', xy: [x, y] });
      points.push([x, y, z]);
    }

    for (const annotation of getToolAnnotations('RectangleROIExclude')) {
      const corners = annotation.data.handles.points.map((pt) => worldToIndex(pt).map(Math.round));
      const { xmin, ymin, xmax, ymax } = boundsOf(corners);
      shapes.push({ type: 'box', start: [xmin, ymin], end: [xmax, ymax] });
    }

    for (const annotation of getToolAnnotations('PlanarFreehandROIExclude')) {
      const vertices = annotation.data.contour.polyline.map((pt) => worldToIndex(pt).map(Math.round));
      shapes.push({ type: 'polygon', points: vertices.map((p) => [p[0], p[1]]) });
    }

    return { shapes, points };
  };

  const onSelectModel = (model: string) => {
    // currentLabel is cleared since the two models' class lists may differ
    // (and SAM2 requires re-confirming one before Run either way) - but
    // brushSnapshot is left alone: it's keyed by segment index, which is a
    // property of the segmentation itself, not of whichever model happens
    // to be selected, so a pending not-yet-sent brush edit stays valid
    // across a model switch instead of being silently discarded.
    setCurrentModel(model);
    setCurrentLabel(null);
  };

  const onSelectLabel = (label: string) => {
    setCurrentLabel(label);
    if (currentShape === 'brush') {
      armBrush(label);
    }
  };

  const onSelectShape = (shape: string) => {
    if (shape === currentShape) {
      // Already this shape - re-running the tool swap is a no-op anyway,
      // and re-snapshotting here would silently discard a pending,
      // not-yet-sent brush edit for no reason.
      return;
    }
    switchTool(toolNameFor(currentShape, excludeMode), toolNameFor(shape, excludeMode));
    setCurrentShape(shape);
    if (shape !== 'brush') {
      if (currentShape === 'brush') {
        unlockAllSegments();
      }
      return;
    }
    // Re-targets the ticked class (it may have changed while another tool
    // was active) - a pending edit for that same class is kept, see armBrush.
    armBrush(currentLabel);
    // The tool group may not have existed yet at mount (e.g. panel opened
    // before the viewport finished initializing) - re-apply here too so the
    // slider's value is never stale once brush is actually selectable.
    applyBrushSize(brushSize);
  };

  // Toggles exclude mode without changing which shape is selected - swaps
  // the active tool for its exclude counterpart (see EXCLUDE_SHAPE_TOOLS),
  // so the next thing you draw with the same shape removes instead of adds.
  const onToggleExclude = () => {
    const nextExcludeMode = !excludeMode;
    switchTool(toolNameFor(currentShape, excludeMode), toolNameFor(currentShape, nextExcludeMode));
    setExcludeMode(nextExcludeMode);
    if (currentShape === 'brush') {
      armBrush(currentLabel);
    }
  };

  const onEnterActionTab = () => {
    commandsManager.runCommand('setToolActive', { toolName: toolNameFor(currentShape, excludeMode) });
    if (currentShape === 'brush') {
      armBrush(currentLabel);
    }
  };

  const onLeaveActionTab = () => {
    commandsManager.runCommand('setToolDisable', { toolName: toolNameFor(currentShape, excludeMode) });
    if (currentShape === 'brush') {
      unlockAllSegments();
    }
  };

  // MonaiLabelPanel calls these two unconditionally on every action tab's
  // ref when the active tab switches. Recreated every render (no deps
  // array) so it always closes over the latest currentShape/excludeMode -
  // cheap, and safer than hand-maintaining a dependency list here.
  useImperativeHandle(ref, () => ({ onEnterActionTab, onLeaveActionTab }));

  const onUndo = () => {
    commandsManager.runCommand('undoMonaiAnnotation');
  };

  const onRedo = () => {
    commandsManager.runCommand('redoMonaiAnnotation');
  };

  const onReset = () => {
    if (!window.confirm('Reset all segments? This clears the entire segmentation and cannot be undone.')) {
      return;
    }
    resetSegmentation();
  };

  const onBrushSizeChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
    const size = Number(evt.target.value);
    setBrushSize(size);
    applyBrushSize(size);
  };

  const onRunInference = async () => {
    const { displaySet } = getActiveViewportInfo();

    const models = getModels(info);
    const model = resolveModel(models, currentModel);
    if (!model) {
      notification.show({
        title: 'MONAI Label',
        message: 'Something went wrong: Model is not selected',
        type: 'error',
        duration: 10000,
      });
      return;
    }

    // SAM2 only ever produces one binary mask per run and has no notion of
    // which of the 8 patterns it is - unlike nnU-Net, which classifies the
    // prompted region into all of them at once - so only the SAM2 model
    // needs a class picked before running.
    if (isSam2Model(info, model) && getModelLabels(info, model).length > 0 && !currentLabel) {
      notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Select a class first',
        type: 'error',
        duration: 6000,
      });
      return;
    }

    // currentShape only tracks which tool is active for drawing right now -
    // Run itself should act on every shape drawn so far regardless of which
    // tool was active when each one was drawn, so gather all kinds.
    const allPrompts = [
      ...buildPointParamsList(),
      ...buildRectangleParamsList(),
      ...buildFreehandParamsList(),
      ...buildBrushParamsList(),
    ];

    const isSam2 = isSam2Model(info, model);
    // The brush prompt is a mask fed to SAM2's own video-propagation API
    // (add_new_mask) - nnU-Net has no comparable mask-prompt input, and a
    // hand-painted single-class mask doesn't fit its "classify everything
    // inside a region" interface anyway. A pending brush edit lingers
    // across shape/model switches on purpose (see buildBrushParamsList/
    // onSelectShape), so it can show up here even though this Run is for a
    // completely different, current shape - skip it rather than blocking
    // everything else this Run was actually meant to do.
    const prompts = isSam2 ? allPrompts : allPrompts.filter((p) => p.kind !== 'brush');
    const skippedBrush = allPrompts.length - prompts.length;

    if (!prompts.length) {
      notification.show({
        title: 'MONAI Label - ' + model,
        message: skippedBrush
          ? 'Brush painting only works with the SAM2 model - switch models to send it'
          : 'Draw a point, rectangle, freehand ROI, or brush stroke on the image first',
        type: 'error',
        duration: 6000,
      });
      return;
    }
    if (skippedBrush) {
      notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Skipping a pending brush edit - switch to the SAM2 model to send it',
        type: 'warning',
        duration: 6000,
      });
    }

    const nid = notification.show({
      title: 'MONAI Label - ' + model,
      message:
        prompts.length > 1
          ? `Running Semi-Segmentation Inference (0/${prompts.length})...`
          : 'Running Semi-Segmentation Inference...',
      type: 'info',
      autoClose: false,
    });

    const config = onOptionsConfig();
    const label_names = info.modelLabelNames[model];
    const { shapes: excludeShapes, points: excludePoints } = buildExcludeShapes();
    setBusy(true);

    let failures = 0;
    let lastError = null;
    let pointRunSucceeded = false;
    let brushRunSucceeded = false;
    let excludeUsed = false;
    // Everything below is wrapped so a thrown exception - e.g. updateView
    // failing to parse a malformed/error response body from the backend -
    // can't skip setBusy(false)/hideNotification: without this, the tab's
    // busy spinner and the "Running..." notification would stay stuck
    // forever even though the backend request itself already finished
    // (response.status !== 200 alone doesn't catch this - MonaiLabelClient's
    // axios wrapper never rejects, but a 200 response with an unexpected
    // body still throws downstream, in updateView, not here).
    try {
      for (let i = 0; i < prompts.length; i++) {
        const { kind, params: roi, xyBounds, z, zMin, zMax, mode } = prompts[i];
        // SAM2 always gets a z bound (its result is only ever real within
        // SAM2_MAX_FRAMES_TO_TRACK of the prompted slice(s)). nnU-Net's
        // result across the full depth is normally a real classification,
        // not a placeholder - EXCEPT for a point prompt, whose hull is
        // grown from one slice's local pixel similarity and which nnU-Net
        // therefore only classifies within a small z window around it too
        // (see POINT_Z_MARGIN/nnunet.py's Z_MIN_SIZE). A brush prompt
        // carries zMin/zMax (the union of every slice it touched) instead
        // of a single z - matches sam2_interactive.py's _propagate_multi,
        // which tracks SAM2_MAX_FRAMES_TO_TRACK past each end of that same
        // range rather than around one slice.
        let bounds = xyBounds;
        if (kind === 'brush' && zMin != null && zMax != null) {
          bounds = { ...xyBounds, zmin: zMin - SAM2_MAX_FRAMES_TO_TRACK, zmax: zMax + SAM2_MAX_FRAMES_TO_TRACK };
        } else if (z != null) {
          if (isSam2) {
            bounds = { ...xyBounds, zmin: z - SAM2_MAX_FRAMES_TO_TRACK, zmax: z + SAM2_MAX_FRAMES_TO_TRACK };
          } else if (kind === 'point') {
            bounds = { ...xyBounds, zmin: z - POINT_Z_MARGIN, zmax: z + POINT_Z_MARGIN };
          }
        }
        const params = {
          ...(config && config.infer && config.infer[model] ? config.infer[model] : {}),
          ...(currentLabel ? { label: currentLabel } : {}),
          ...roi,
          // exclude_shapes: guaranteed post-hoc cut, every model/prompt type.
          // background: SAM2's own native negative-point input (points
          // only) - harmless to also send when the model is nnU-Net, which
          // ignores it.
          ...(excludeShapes.length ? { exclude_shapes: excludeShapes } : {}),
          ...(excludePoints.length ? { background: excludePoints } : {}),
        };

        // eslint-disable-next-line no-await-in-loop
        const response = await props.client().infer(model, displaySet.SeriesInstanceUID, params);

        if (response.status !== 200) {
          failures++;
          lastError = response;
          console.error('Semi-Segmentation prompt failed', response);
          continue;
        }

        if (kind === 'point') {
          pointRunSucceeded = true;
        }
        if (kind === 'brush') {
          brushRunSucceeded = true;
        }
        if (excludeShapes.length) {
          excludeUsed = true;
        }

        // override=true merges this run's mask into the existing labelmap
        // (only voxels currently 0 or already this class get touched)
        // instead of replacing the whole volume - so classes/regions from
        // earlier runs stay visible. xyBounds further restricts that merge
        // to this run's own drawn region, so separate shapes never clobber
        // each other. mode ('remove' for a brush-erase prompt, 'add-brush'
        // for a brush-paint prompt, 'add' for every other prompt type) tells
        // it whether to merge this class in, carve it back out, or
        // (add-brush) merge in additively without clearing anything else
        // nearby.
        // eslint-disable-next-line no-await-in-loop
        await updateView(response, model, label_names, true, false, -1, bounds, mode);
      }

      // Points are consumed once used - clear them so the next points
      // placed start a fresh outline instead of silently combining with
      // these.
      if (pointRunSucceeded) {
        clearPointAnnotations();
      }
      if (excludeUsed) {
        clearExcludeAnnotations();
      }
      // Re-arm the brush baseline against the now-updated segmentation
      // (which just gained/lost whatever SAM2 propagated), so the next
      // stroke diffs cleanly instead of against the pre-propagation state.
      if (brushRunSucceeded) {
        snapshotBrush(currentLabel);
      }

      hideNotification(nid, notification);

      if (failures === prompts.length) {
        notification.show({
          title: 'MONAI Label - ' + model,
          message: `Semi-Segmentation Inference failed: ${describeError(lastError)}`,
          type: 'error',
          duration: 8000,
        });
        return;
      }

      onModelUsed?.(model);

      notification.show({
        title: 'MONAI Label - ' + model,
        message:
          failures > 0
            ? `Running Semi-Segmentation Inference - ${prompts.length - failures}/${prompts.length} succeeded (${describeError(lastError)})`
            : 'Running Semi-Segmentation Inference - Successful',
        type: failures > 0 ? 'warning' : 'success',
        duration: failures > 0 ? 8000 : 4000,
      });
    } catch (e) {
      console.error('Semi-Segmentation inference failed', e);
      hideNotification(nid, notification);
      notification.show({
        title: 'MONAI Label - ' + model,
        message: `Semi-Segmentation Inference failed: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const models = getModels(info);
  const display = models.length > 0 ? 'block' : 'none';
  // ModelSelector defaults to the first model until the user changes it
  // without telling this component - mirror that default here too.
  const model = resolveModel(models, currentModel);
  const labels = getModelLabels(info, model);
  const segInfo = segmentInfo();

  return (
    <div className="tab" style={{ display: display }}>
      <input
        type="radio"
        name="rd"
        id={tabId}
        className="tab-switch"
        defaultValue="semisegmentation"
        onClick={onSelectActionTab}
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Semi-Segmentation
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <div className="annotationToolRow">
          <button
            className={`annotationToolButton ${currentShape === 'point' ? 'active' : ''}`}
            title="Point"
            onClick={() => onSelectShape('point')}
          >
            <Icon name="tool-probe" width="16px" height="16px" />
          </button>
          <button
            className={`annotationToolButton ${currentShape === 'rectangle' ? 'active' : ''}`}
            title="Rectangle"
            onClick={() => onSelectShape('rectangle')}
          >
            <Icon name="tool-rectangle" width="16px" height="16px" />
          </button>
          <button
            className={`annotationToolButton ${currentShape === 'freehand' ? 'active' : ''}`}
            title="Freehand"
            onClick={() => onSelectShape('freehand')}
          >
            <Icon name="icon-tool-freehand-roi" width="16px" height="16px" />
          </button>
          <button
            className={`annotationToolButton ${currentShape === 'brush' ? 'active' : ''}`}
            title="Brush - paints/erases the selected class directly, then SAM2 propagates the edit to other slices on Run"
            onClick={() => onSelectShape('brush')}
          >
            <Icon name="icon-tool-brush" width="16px" height="16px" />
          </button>
          <button
            className={`annotationToolButton excludeToolButton ${excludeMode ? 'active' : ''}`}
            title={
              currentShape === 'brush'
                ? excludeMode
                  ? 'Exclude mode ON - the brush now erases the selected class'
                  : 'Exclude mode - toggle on to erase the selected class with the brush instead of painting it'
                : excludeMode
                  ? 'Exclude mode ON - the shape tools above now remove from the result'
                  : 'Exclude mode - toggle on, then draw with the shape tools above to remove from the result'
            }
            onClick={onToggleExclude}
          >
            <ExcludeIcon />
          </button>
          <div className="annotationToolDivider" />
          <button className="annotationToolButton" title="Undo last annotation" onClick={onUndo}>
            <UndoIcon />
          </button>
          <button className="annotationToolButton" title="Redo annotation" onClick={onRedo}>
            <RedoIcon />
          </button>
          <div className="annotationToolDivider" />
          <button className="annotationToolButton" title="Reset all segments" onClick={onReset}>
            <ResetIcon />
          </button>
        </div>
        {currentShape === 'brush' && (
          <div className="brushSizeRow">
            <span className="brushSizeLabel">Brush Radius</span>
            <input
              type="range"
              min={MIN_BRUSH_SIZE}
              max={MAX_BRUSH_SIZE}
              step={1}
              value={brushSize}
              onChange={onBrushSizeChange}
              title={`${brushSize}mm radius`}
              style={
                {
                  '--pct': `${((brushSize - MIN_BRUSH_SIZE) / (MAX_BRUSH_SIZE - MIN_BRUSH_SIZE)) * 100}%`,
                } as React.CSSProperties
              }
            />
            <span className="brushSizeValue">{brushSize}mm</span>
          </div>
        )}
        <ModelSelector
          title="Semi-Segmentation"
          models={models}
          currentModel={currentModel}
          onClick={onRunInference}
          onSelectModel={onSelectModel}
          usage={
            <div style={{ fontSize: 'smaller' }}>
              <br />
              <p>
                {currentShape === 'brush'
                  ? 'Pick a class below, then paint (or, with Exclude on, erase) it directly on the image. Run sends that edit to SAM2 to propagate across the rest of the slices.'
                  : 'Pick a tool above, draw on the image, then run inference.'}{' '}
                {isSam2Model(info, model)
                  ? 'SAM2 traces one object per run - pick a class below first to say which pattern it is.'
                  : 'All classes found in that region are segmented at once - check a class below just to highlight it.'}
              </p>
            </div>
          }
        />
        {labels.length > 0 && (
          <div className="optionsTableContainer">
            <hr />
            <p>Class:</p>
            <hr />
            <div className="bodyTableContainer">
              <table className="optionsTable">
                <tbody>
                  {labels.map((label) => (
                    <tr key={label} className="clickable-row" onClick={() => onSelectLabel(label)}>
                      <td>
                        <input type="checkbox" checked={currentLabel === label} readOnly />
                      </td>
                      <td>
                        <span
                          className="segColor"
                          style={{ backgroundColor: segColorToRgb(segInfo[label]) }}
                        />
                      </td>
                      <td>{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

SemiSegmentation.displayName = 'SemiSegmentation';

export default SemiSegmentation;
