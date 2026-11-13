import { eventTarget, getEnabledElements, cache } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { copyLabelmap, notifyModified, sliceArrays, writeLabelmap } from './labelmapAccess';
import { decodeLabelmap, encodeLabelmapBuffer, IDENTITY_LUT } from './labelmapRle';

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
// A change touching very many voxels (a whole AI result): stored as compact
// run-length copies of the whole labelmap before and after, not per voxel -
// ~1-2 MB instead of ~60 MB for 10 million changed voxels.
type VolumeEntry = { type: 'volume'; before: ArrayBuffer; after: ArrayBuffer };
type HistoryEntry = AnnotationEntry | VoxelsEntry | VolumeEntry;

// Above this many changed voxels an edit is stored as a VolumeEntry.
const LARGE_CHANGE = 1_000_000;

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

    // Runs on every brush movement, so it must stay cheap: no whole-volume
    // reads here (getCompleteScalarDataArray copies ~100 MB per call).
    const volume = getSegmentationVolume();
    const [width, height, depth] = volume?.dimensions || [];
    const total = width * height * depth;
    if (!total) {
      return;
    }

    if (!this.lastScalarData || this.lastScalarData.length !== total) {
      // First time observing this volume (or it changed size/identity) -
      // nothing to diff against yet, just establish the baseline.
      this.lastScalarData = copyLabelmap(volume);
      return;
    }

    // Edits report exactly which slice(s) they touched - just record that
    // rather than diffing here. Anything that doesn't falls back to every
    // slice - still deferred the same way.
    const slices =
      modifiedSlicesToUse && modifiedSlicesToUse.length
        ? modifiedSlicesToUse
        : Array.from({ length: depth }, (_, i) => i);
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
    const slices = Array.from(this.dirtySlices).sort((x, y) => x - y);
    this.dirtySlices = new Set();
    const last = this.lastScalarData;
    const volume = getSegmentationVolume();
    if (!slices.length || !volume || !last) {
      return;
    }
    const [width, height] = volume.dimensions || [];
    const sliceLength = width * height;
    // Live slice arrays (no copy); whole-volume copy only as a fallback.
    const arrays = sliceArrays(volume);
    const full = arrays ? null : volume.voxelManager?.getCompleteScalarDataArray();
    if (!arrays && (!full || full.length !== last.length)) {
      return;
    }
    const sliceOf = (z) => (arrays ? arrays[z] : full.subarray(z * sliceLength, (z + 1) * sliceLength));

    // Changed voxels, in growable typed arrays (a Map per voxel was far too
    // slow and memory-hungry for an AI result changing millions of them).
    let cap = 4096;
    let indices = new Uint32Array(cap);
    let oldValues = new Uint8Array(cap);
    let newValues = new Uint8Array(cap);
    let count = 0;
    let large = false;
    for (const z of slices) {
      const now = sliceOf(z);
      const base = z * sliceLength;
      for (let j = 0; j < sliceLength; j++) {
        const v = now[j];
        if (v === last[base + j]) {
          continue;
        }
        if (count === cap) {
          if (cap >= LARGE_CHANGE) {
            large = true;
            break;
          }
          cap *= 2;
          const i2 = new Uint32Array(cap);
          i2.set(indices);
          indices = i2;
          const o2 = new Uint8Array(cap);
          o2.set(oldValues);
          oldValues = o2;
          const n2 = new Uint8Array(cap);
          n2.set(newValues);
          newValues = n2;
        }
        indices[count] = base + j;
        oldValues[count] = last[base + j];
        newValues[count] = v;
        count++;
      }
      if (large) {
        break;
      }
    }

    if (large) {
      const before = encodeLabelmapBuffer(last);
      for (const z of slices) {
        last.set(sliceOf(z), z * sliceLength);
      }
      this.undoStack.push({ type: 'volume', before, after: encodeLabelmapBuffer(last) });
      this.redoStack = [];
      return;
    }
    if (!count) {
      return;
    }
    for (let k = 0; k < count; k++) {
      last[indices[k]] = newValues[k];
    }
    this.undoStack.push({
      type: 'voxels',
      indices: indices.slice(0, count),
      oldValues: oldValues.slice(0, count),
      newValues: newValues.slice(0, count),
    });
    this.redoStack = [];
  };

  // A stroke still "in flight" (mid-coalesce, or diffed-but-not-yet-flushed
  // dirty slices) needs to finalize into its own entry before undo/redo
  // starts touching the stack, so it isn't lost or wrongly bundled with
  // whatever gets undone/redone next. flushDirtySlices already ends by
  // committing its own entry, so nothing further is needed here.
  private flushPendingChanges() {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.flushDirtySlices();
  }

  // Writes just the entry's voxels into the live slices and redraws just
  // those slices.
  private applyVoxels = (entry: VoxelsEntry, direction: 'undo' | 'redo') => {
    const volume = getSegmentationVolume();
    const arrays = sliceArrays(volume);
    const values = direction === 'undo' ? entry.oldValues : entry.newValues;
    if (!arrays) {
      const scalarData = volume?.voxelManager?.getCompleteScalarDataArray();
      if (!scalarData) {
        return;
      }
      for (let i = 0; i < entry.indices.length; i++) {
        scalarData[entry.indices[i]] = values[i];
      }
      writeLabelmap(volume, scalarData);
      this.lastScalarData = new Uint8Array(scalarData);
      return;
    }
    const [width, height] = volume.dimensions;
    const sliceLength = width * height;
    const touched = new Set<number>();
    for (let i = 0; i < entry.indices.length; i++) {
      const index = entry.indices[i];
      const z = (index / sliceLength) | 0;
      arrays[z][index - z * sliceLength] = values[i];
      if (this.lastScalarData) {
        this.lastScalarData[index] = values[i];
      }
      touched.add(z);
    }
    notifyModified(volume, Array.from(touched));
  };

  private applyVolume = (entry: VolumeEntry, direction: 'undo' | 'redo') => {
    const volume = getSegmentationVolume();
    if (!volume) {
      return;
    }
    const [width, height, depth] = volume.dimensions;
    const { data } = decodeLabelmap(
      direction === 'undo' ? entry.before : entry.after,
      width * height * depth,
      IDENTITY_LUT
    );
    writeLabelmap(volume, data);
    this.lastScalarData = data;
  };

  private apply = (entry: HistoryEntry, direction: 'undo' | 'redo') => {
    this.suppressTracking = true;
    try {
      if (entry.type === 'voxels') {
        this.applyVoxels(entry, direction);
      } else if (entry.type === 'volume') {
        this.applyVolume(entry, direction);
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
    this.lastScalarData = copyLabelmap(getSegmentationVolume());
    this.undoStack = [];
    this.redoStack = [];
  };

  // Replacing the whole labelmap at once (a loaded save, an AI result): the
  // caller already holds the new state, so there's nothing to discover by
  // diffing ~100 million voxels - writes go through with tracking off, and
  // `data` (owned by the history from now on - don't modify it) becomes the
  // new baseline directly.
  private replaceWith(write: () => void, data: Uint8Array) {
    this.flushPendingChanges(); // a brush stroke still settling becomes its own entry first
    this.suppressTracking = true;
    try {
      write();
    } finally {
      this.suppressTracking = false;
    }
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.dirtySlices = new Set();
    this.lastScalarData = data;
  }

  // A wholesale state install that isn't a user edit (e.g. loading a saved
  // segmentation): becomes the fresh baseline, with no undo step back past it
  // (see resetBaseline).
  installState = (write: () => void, data: Uint8Array) => {
    this.replaceWith(write, data);
    this.undoStack = [];
    this.redoStack = [];
  };

  // A whole-volume edit that should be undoable (a full AI result): recorded
  // as one compact run-length entry, before -> after.
  recordReplace = (write: () => void, data: Uint8Array) => {
    this.flushPendingChanges();
    const before = this.lastScalarData ? encodeLabelmapBuffer(this.lastScalarData) : null;
    this.replaceWith(write, data);
    if (before) {
      this.undoStack.push({ type: 'volume', before, after: encodeLabelmapBuffer(data) });
      this.redoStack = [];
    }
  };

  // Whether anything was edited since the last installState (load).
  hasEdits = () => {
    this.flushPendingChanges();
    return this.undoStack.length > 0;
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
