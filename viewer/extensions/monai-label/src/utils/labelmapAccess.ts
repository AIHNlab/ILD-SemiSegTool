// Fast, slice-wise access to the segmentation labelmap, so no edit has to
// touch the whole volume (~100 million voxels for a CT) when it only changed
// part of it - this is what keeps the viewer responsive on tablets and phones.
//
// Why not cornerstone3D's own whole-volume calls (2.2.3, image-backed volumes):
// - voxelManager.getCompleteScalarDataArray() allocates and fills a fresh full
//   copy on every call;
// - setCompleteScalarDataArray() runs Math.min/Math.max over every voxel and
//   marks every slice modified, so the whole labelmap is re-uploaded to the GPU.
// Each slice's image keeps its own pixel array; these read and write those
// arrays directly and report exactly which slices changed (only those are
// re-uploaded - see cornerstone's onLabelmapSegmentationDataModified).
import { cache, eventTarget } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

export const SEGMENTATION_ID = '1';

// The live pixel array of every slice (no copies), or null if this volume
// isn't image-backed the way these helpers expect - callers then fall back to
// the whole-volume calls.
export function sliceArrays(volume): Uint8Array[] | null {
  const ids = volume?.imageIds;
  const [width, height, depth] = volume?.dimensions || [];
  if (!ids || !depth || ids.length !== depth) {
    return null;
  }
  const sliceLength = width * height;
  const arrays = new Array(depth);
  for (let z = 0; z < depth; z++) {
    const image = cache.getImage(ids[z]);
    let pixels = null;
    try {
      pixels = image?.voxelManager?.getScalarData?.() ?? image?.getPixelData?.();
    } catch (e) {
      pixels = null;
    }
    if (!pixels || pixels.length !== sliceLength) {
      return null;
    }
    arrays[z] = pixels;
  }
  return arrays;
}

const allSlices = (depth: number) => Array.from({ length: depth }, (_, z) => z);

// Tells cornerstone (and our own listeners, e.g. undo history) which slices
// changed, so only those are redrawn / re-uploaded.
export function notifyModified(volume, slices: number[]) {
  const voxelManager = volume?.voxelManager;
  slices.forEach((z) => voxelManager?.modifiedSlices?.add(z));
  cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
    SEGMENTATION_ID,
    slices
  );
}

// Writes a whole-volume labelmap `data`, but only into `slices` (all if
// omitted), then notifies for just those slices.
export function writeLabelmap(volume, data: Uint8Array, slices?: number[]) {
  const [width, height, depth] = volume.dimensions;
  const sliceLength = width * height;
  const toWrite = slices ?? allSlices(depth);
  const arrays = sliceArrays(volume);
  if (!arrays) {
    volume.voxelManager.setCompleteScalarDataArray(data);
    cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      SEGMENTATION_ID,
      toWrite
    );
    return;
  }
  for (const z of toWrite) {
    arrays[z].set(data.subarray(z * sliceLength, (z + 1) * sliceLength));
  }
  notifyModified(volume, toWrite);
}

// A copy of the whole labelmap (for a baseline to diff against later).
export function copyLabelmap(volume): Uint8Array | null {
  const arrays = sliceArrays(volume);
  if (!arrays) {
    const data = volume?.voxelManager?.getCompleteScalarDataArray();
    return data ? new Uint8Array(data) : null;
  }
  const sliceLength = arrays[0]?.length || 0;
  const out = new Uint8Array(sliceLength * arrays.length);
  arrays.forEach((pixels, z) => out.set(pixels, z * sliceLength));
  return out;
}

// Collects which slices change from now on (brush strokes report their
// slices; anything that doesn't sets `all`). stop() when done.
export function trackModifiedSlices() {
  const tracker = {
    slices: new Set<number>(),
    all: false,
    stop: () => {},
  };
  const listener = (evt) => {
    const { segmentationId, modifiedSlicesToUse } = evt.detail || {};
    if (segmentationId && segmentationId !== SEGMENTATION_ID) {
      return;
    }
    if (modifiedSlicesToUse?.length) {
      modifiedSlicesToUse.forEach((z) => tracker.slices.add(z));
    } else {
      tracker.all = true;
    }
  };
  const event = cornerstoneTools.Enums.Events.SEGMENTATION_DATA_MODIFIED;
  eventTarget.addEventListener(event, listener);
  tracker.stop = () => eventTarget.removeEventListener(event, listener);
  return tracker;
}
