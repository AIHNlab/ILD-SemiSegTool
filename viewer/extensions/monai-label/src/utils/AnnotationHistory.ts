import { eventTarget, getEnabledElements, cache, triggerEvent } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

const TRACKED_TOOLS = [
  'ProbeMONAILabel',
  'ProbeMONAILabelExclude',
  'RectangleROI',
  'PlanarFreehandROI',
  'RectangleROIExclude',
  'PlanarFreehandROIExclude',
];

// The single MONAI Label labelmap segmentation this whole extension reads
// and writes (see MonaiLabelPanel.tsx/SemiSegmentation.tsx - always '1').
const SEGMENTATION_ID = '1';

// Brush strokes fire SEGMENTATION_DATA_MODIFIED continuously while dragging
// (once per incremental fill/erase step), not once at the end of the
// stroke - without coalescing, a single visible stroke would turn into
// dozens of undo entries, each undoing only a sliver of it. Any run of
// modifications with no gap longer than this counts as one stroke/undo unit.
const VOXEL_COALESCE_MS = 500;

type AnnotationEntry = { type: 'add' | 'remove'; annotation: any };
type VoxelsEntry = {
  type: 'voxels';
  indices: Uint32Array;
  oldValues: Uint8Array;
  newValues: Uint8Array;
};
type HistoryEntry = AnnotationEntry | VoxelsEntry;

/**
 * Removing/re-adding annotations via the state API doesn't trigger the SVG
 * annotation overlay to redraw on its own (that only happens on tool
 * interaction or viewport events), so undo/redo must force it explicitly.
 * Exported for other call sites that remove annotations directly through
 * the state API (e.g. auto-clearing consumed point prompts) and need the
 * same forced redraw - they don't need suppressTracking since, unlike
 * undo/redo/clearAll below, that removal SHOULD be trackable by this same
 * history (ANNOTATION_REMOVED fires regardless of who calls removeAnnotation).
 */
export function renderAllViewports() {
  const viewportIds = getEnabledElements()
    .map((el) => el?.viewportId)
    .filter(Boolean);
  cornerstoneTools.utilities.triggerAnnotationRenderForViewportIds(viewportIds);
}

// SEGMENTATION_ID ('1') is only the segmentation's LOGICAL id - the actual
// labelmap volume lives in cornerstone3D's volume cache under a separate,
// internally-generated volumeId, reachable via the registered segmentation's
// own representationData (this is exactly what OHIF's own
// SegmentationService.getLabelmapVolume does - reproduced here directly
// since this module has no access to servicesManager). cache.getVolume
// (SEGMENTATION_ID) - i.e. looking up a volume literally named '1' - does
// NOT resolve to it, and silently returns undefined.
function getSegmentationVolume() {
  const segmentation = cornerstoneTools.segmentation.state.getSegmentation(SEGMENTATION_ID);
  const volumeId =
    segmentation?.representationData?.[cornerstoneTools.Enums.SegmentationRepresentations.Labelmap]
      ?.volumeId;
  return volumeId ? cache.getVolume(volumeId) : null;
}

/**
 * Tracks completed/removed annotations for the ROI prompt tools (point/
 * rectangle/freehand) AND direct edits to the segmentation's voxel data
 * (brush strokes, and a completed inference run merging its result in) so
 * all of the above can be undone/redone through one shared stack.
 * cornerstone3D has no built-in undo/redo, so this listens for
 * ANNOTATION_COMPLETED/ANNOTATION_REMOVED (for the annotation-based prompt
 * tools) and SEGMENTATION_DATA_MODIFIED (for the brush and inference-merge
 * paths, which write straight to the labelmap with no annotation at all)
 * and maintains a single command-style undo/redo stack across both.
 * `suppressTracking` is used while THIS class is the one doing the
 * removing/re-adding/rewriting, to avoid feeding its own actions back into
 * the history.
 */
class AnnotationHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private suppressTracking = false;

  // Last known scalar data for the segmentation volume - the "before" state
  // the NEXT voxel diff compares against. Kept in sync after every commit,
  // including undo/redo's own writes (those go through suppressTracking so
  // they don't ALSO get diffed back into a new entry).
  private lastScalarData: Uint8Array | null = null;
  // Accumulates changes across the current coalescing window before they
  // become a real undo entry - keyed by voxel index so repeated touches
  // within one stroke keep the ORIGINAL pre-stroke value as "old".
  private pendingChanges: Map<number, { oldValue: number; newValue: number }> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  // Slice indices touched since the last flush, recorded cheaply by
  // onSegmentationModified while a stroke is still in progress - the actual
  // per-pixel diff against lastScalarData (see flushDirtySlices) is deferred
  // until the stroke settles, rather than re-run on every one of the many
  // events a single drag fires while the mouse is still moving.
  private dirtySlices: Set<number> = new Set();

  constructor() {
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
      this.onAnnotationCompleted
    );
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_REMOVED,
      this.onAnnotationRemoved
    );
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.SEGMENTATION_DATA_MODIFIED,
      this.onSegmentationModified
    );
  }

  private isTracked = (annotation) =>
    TRACKED_TOOLS.includes(annotation?.metadata?.toolName);

  private onAnnotationCompleted = (evt) => {
    if (this.suppressTracking) {
      return;
    }
    const { annotation } = evt.detail;
    if (!this.isTracked(annotation)) {
      return;
    }
    this.undoStack.push({ type: 'add', annotation });
    this.redoStack = [];
  };

  private onAnnotationRemoved = (evt) => {
    if (this.suppressTracking) {
      return;
    }
    const { annotation } = evt.detail;
    if (!this.isTracked(annotation)) {
      return;
    }
    this.undoStack.push({ type: 'remove', annotation });
    this.redoStack = [];
  };

  // Brush strokes (and a completed inference run merging its result in)
  // edit the segmentation's voxel data directly rather than through an
  // annotation, so there's nothing for onAnnotationCompleted/Removed to
  // see - this diffs the volume's current scalar data against whatever it
  // was last time to capture that as its own kind of undoable entry.
  private onSegmentationModified = (evt) => {
    if (this.suppressTracking) {
      return;
    }
    const { segmentationId, modifiedSlicesToUse } = evt.detail || {};
    if (segmentationId && segmentationId !== SEGMENTATION_ID) {
      return;
    }

    const volume = getSegmentationVolume();
    const scalarData = volume?.voxelManager?.getCompleteScalarDataArray();
    if (!scalarData) {
      return;
    }

    if (!this.lastScalarData || this.lastScalarData.length !== scalarData.length) {
      // First time observing this volume (or it changed size/identity) -
      // nothing to diff against yet, just establish the baseline.
      this.lastScalarData = new Uint8Array(scalarData);
      return;
    }

    // Brush events report exactly which slice(s) they touched - just record
    // that (a Set add is effectively free) rather than diffing them here.
    // Inference-run merges (updateView) don't report this, so fall back to
    // every slice - still deferred the same way, since that only happens
    // once per Run rather than repeatedly like a drag.
    const [width, height, depth] = volume.dimensions || [];
    const sliceLength = width * height;
    const slices =
      modifiedSlicesToUse && modifiedSlicesToUse.length
        ? modifiedSlicesToUse
        : Array.from({ length: depth || scalarData.length / sliceLength }, (_, i) => i);
    slices.forEach((sliceIndex) => this.dirtySlices.add(sliceIndex));

    // Re-armed on every event, so this only actually fires once the stream
    // of modification events stops - i.e. once the drag/stroke has
    // completed (mouse release) rather than mid-drag. This is what pushes
    // the expensive per-pixel diff (flushDirtySlices, below) off the live
    // dragging path entirely.
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
    }
    this.coalesceTimer = setTimeout(this.flushDirtySlices, VOXEL_COALESCE_MS);
  };

  // Runs the per-pixel diff against lastScalarData for every slice touched
  // since the last flush, in one pass - only called once a stroke has
  // settled (see onSegmentationModified's coalesceTimer) or when something
  // needs the history brought fully up to date first (undo/redo/clearAll,
  // via flushPendingChanges), never on every intermediate drag tick.
  private flushDirtySlices = () => {
    this.coalesceTimer = null;
    const slices = this.dirtySlices;
    this.dirtySlices = new Set();
    if (!slices.size) {
      return;
    }

    const volume = getSegmentationVolume();
    const scalarData = volume?.voxelManager?.getCompleteScalarDataArray();
    if (!scalarData || !this.lastScalarData || this.lastScalarData.length !== scalarData.length) {
      return;
    }

    const [width, height] = volume.dimensions || [];
    const sliceLength = width * height;

    if (!this.pendingChanges) {
      this.pendingChanges = new Map();
    }

    for (const sliceIndex of slices) {
      const begin = sliceIndex * sliceLength;
      const end = Math.min(begin + sliceLength, scalarData.length);
      for (let i = begin; i < end; i++) {
        const newValue = scalarData[i];
        if (newValue === this.lastScalarData[i]) {
          continue;
        }
        const existing = this.pendingChanges.get(i);
        this.pendingChanges.set(i, {
          oldValue: existing ? existing.oldValue : this.lastScalarData[i],
          newValue,
        });
        this.lastScalarData[i] = newValue;
      }
    }

    this.commitPendingChanges();
  };

  private commitPendingChanges = () => {
    this.coalesceTimer = null;
    const changes = this.pendingChanges;
    this.pendingChanges = null;
    if (!changes || !changes.size) {
      return;
    }
    const indices = new Uint32Array(changes.size);
    const oldValues = new Uint8Array(changes.size);
    const newValues = new Uint8Array(changes.size);
    let i = 0;
    for (const [index, { oldValue, newValue }] of changes) {
      indices[i] = index;
      oldValues[i] = oldValue;
      newValues[i] = newValue;
      i++;
    }
    this.undoStack.push({ type: 'voxels', indices, oldValues, newValues });
    this.redoStack = [];
  };

  // A stroke still "in flight" (mid-coalesce, or diffed-but-not-yet-flushed
  // dirty slices) needs to finalize into its own entry before undo/redo
  // starts touching the stack, so it isn't lost or wrongly bundled with
  // whatever gets undone/redone next. flushDirtySlices already ends by
  // calling commitPendingChanges itself, so nothing further is needed here.
  private flushPendingChanges() {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.flushDirtySlices();
  }

  private applyVoxels = (entry: VoxelsEntry, direction: 'undo' | 'redo') => {
    const volume = getSegmentationVolume();
    const voxelManager = volume?.voxelManager;
    const scalarData = voxelManager?.getCompleteScalarDataArray();
    if (!scalarData) {
      return;
    }
    const values = direction === 'undo' ? entry.oldValues : entry.newValues;
    for (let i = 0; i < entry.indices.length; i++) {
      scalarData[entry.indices[i]] = values[i];
    }
    voxelManager.setCompleteScalarDataArray(scalarData);
    this.lastScalarData = new Uint8Array(scalarData);
    triggerEvent(eventTarget, cornerstoneTools.Enums.Events.SEGMENTATION_DATA_MODIFIED, {
      segmentationId: SEGMENTATION_ID,
    });
  };

  private apply = (entry: HistoryEntry, direction: 'undo' | 'redo') => {
    this.suppressTracking = true;
    try {
      if (entry.type === 'voxels') {
        this.applyVoxels(entry, direction);
      } else {
        // undoing an 'add' removes it; undoing a 'remove' restores it -
        // and vice-versa for redo.
        const shouldRemove =
          (direction === 'undo' && entry.type === 'add') ||
          (direction === 'redo' && entry.type === 'remove');
        if (shouldRemove) {
          cornerstoneTools.annotation.state.removeAnnotation(
            entry.annotation.annotationUID
          );
        } else {
          cornerstoneTools.annotation.state.addAnnotation(entry.annotation);
        }
      }
    } finally {
      this.suppressTracking = false;
    }
    renderAllViewports();
  };

  undo = () => {
    this.flushPendingChanges();
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }
    this.apply(entry, 'undo');
    this.redoStack.push(entry);
  };

  redo = () => {
    this.flushPendingChanges();
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }
    this.apply(entry, 'redo');
    this.undoStack.push(entry);
  };

  // Establishes the CURRENT volume state as a fresh undo baseline, with no
  // undo entry for the jump from whatever was there a moment ago. Meant for
  // a wholesale state install that isn't itself a user edit - e.g. loading
  // a previously-saved segmentation on startup, right after the blank
  // segmentation's own creation already fired one SEGMENTATION_DATA_MODIFIED
  // event (which set lastScalarData to that all-zero state). Without this,
  // the very next real SEGMENTATION_DATA_MODIFIED (the load itself) would
  // diff blank-vs-loaded and record it as one giant undo entry, so hitting
  // Undo once right after opening the app would wipe the loaded
  // segmentation back to blank - "further back" than the loaded state ever
  // should be. flushPendingChanges() first, so a diff already in flight
  // from that earlier event doesn't land in undoStack a moment after this
  // clears it.
  resetBaseline = () => {
    this.flushPendingChanges();
    const volume = getSegmentationVolume();
    const scalarData = volume?.voxelManager?.getCompleteScalarDataArray();
    this.lastScalarData = scalarData ? new Uint8Array(scalarData) : null;
    this.undoStack = [];
    this.redoStack = [];
  };

  clearAll = () => {
    this.flushPendingChanges();
    this.suppressTracking = true;
    try {
      for (const toolName of TRACKED_TOOLS) {
        cornerstoneTools.annotation.state.removeAnnotations(toolName);
      }
    } finally {
      this.suppressTracking = false;
    }
    this.undoStack = [];
    this.redoStack = [];
    renderAllViewports();
  };
}

export default new AnnotationHistory();
