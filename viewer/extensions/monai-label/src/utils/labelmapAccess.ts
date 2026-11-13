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
import {
  cache,
  Enums as csEnums,
  eventTarget,
  geometryLoader,
  getRenderingEngines,
} from '@cornerstonejs/core';
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

// 3D view, part 1: cornerstone (2.2.3, polySeg updateSurfaceData) crashes when
// a class appears that has no 3D surface yet - it creates one without passing
// the viewport, and reading options.viewport.id for the colour throws. The
// class is then registered with no surface ("No Surfaces found for geometryId
// ...") and the rest of that update is lost (old surfaces aren't cleared). So
// before that update runs (0.3 s after each change), give every class of the
// segmentation a surface entry - empty if it has no voxels; cornerstone fills
// it in on its normal path. Does nothing unless 3D surfaces exist.
export function ensureSurfaceEntries() {
  const segmentation = cornerstoneTools.segmentation.state.getSegmentation(SEGMENTATION_ID) as any;
  const geometryIds = segmentation?.representationData?.Surface?.geometryIds;
  if (!geometryIds) {
    return;
  }
  for (const key of Object.keys(segmentation.segments || {})) {
    const segmentIndex = Number(key);
    if (!segmentIndex) {
      continue;
    }
    const geometryId = `segmentation_${SEGMENTATION_ID}_surface_${segmentIndex}`;
    if (!cache.getGeometry(geometryId)) {
      // cornerstone refuses to create an empty surface, so create it with one
      // degenerate triangle and empty it right away (what it does itself to
      // clear a class).
      const geometry = geometryLoader.createAndCacheGeometry(geometryId, {
        type: csEnums.GeometryType.SURFACE,
        geometryData: {
          id: geometryId,
          color: [128, 128, 128], // replaced by the class colour when drawn
          frameOfReferenceUID: 'test-frameOfReferenceUID', // what cornerstone uses for these too
          points: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          polys: [3, 0, 1, 2],
          segmentIndex,
        },
      } as any) as any;
      if (geometry?.data) {
        geometry.data.points = [];
        geometry.data.polys = [];
      }
    }
    if (geometryIds.get(segmentIndex) !== geometryId) {
      geometryIds.set(segmentIndex, geometryId);
    }
  }
}

// 3D view, part 3: cornerstone (2.2.3, addOrUpdateSurfaceToElement) gives a
// new surface actor the id of the existing actor for that class - looked up
// before the actor exists, so always undefined. Later renders can then never
// find the actor again: they never update or empty it, and add another actor
// on top each time. That's how a class that disappeared (lung) stayed in the
// 3D view. So label each new surface actor with the id cornerstone looks for
// ("<segmentation>-Surface-<class>"); it then updates the class's one actor in
// place (empties it when the class is gone).
const SURFACE_UID_PREFIX = `${SEGMENTATION_ID}-Surface-`;

function surfaceGeometries() {
  const segmentation = cornerstoneTools.segmentation.state.getSegmentation(SEGMENTATION_ID) as any;
  const geometryIds = segmentation?.representationData?.Surface?.geometryIds;
  const out = [];
  geometryIds?.forEach((geometryId, segmentIndex) => {
    const surface = cache.getGeometry(geometryId)?.data as any;
    if (surface) {
      out.push({ segmentIndex: Number(segmentIndex), surface });
    }
  });
  return out;
}

const sameColor = (a, b) => a && b && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) < 1e-3);

// Which class a just-built surface actor shows: cornerstone sets its colour
// to the class colour and builds it from that class's surface points.
function segmentIndexOfActor(viewport, actor) {
  const color = actor?.getProperty?.()?.getColor?.();
  const pointCount = actor?.getMapper?.()?.getInputData?.()?.getPoints?.()?.getData?.()?.length;
  const taken = new Set(
    (viewport.getActors?.() || []).map((entry) => entry.representationUID).filter(Boolean)
  );
  const rgb = (c) => (c || []).slice(0, 3).map((v) => v / 255);
  const candidates = surfaceGeometries().filter(
    ({ segmentIndex, surface }) =>
      !taken.has(`${SURFACE_UID_PREFIX}${segmentIndex}`) &&
      surface.points?.length === pointCount &&
      sameColor(rgb(surface.color), color)
  );
  return candidates.length ? candidates[0].segmentIndex : null;
}

// A plain 3D-view surface actor cornerstone added without an id.
const isUntaggedSurfaceActor = (entry) =>
  !entry.representationUID &&
  entry.actor?.isA?.('vtkActor') &&
  !entry.actor?.isA?.('vtkVolume') &&
  entry.actor?.getMapper?.()?.getInputData?.()?.getPolys;

// Removes 3D surface actors from a 2D viewport (left there when a 3D surface
// representation was put on it; see MonaiLabelPanel.restoreSegmentationOnViewports).
export function removeSurfaceActors(viewport) {
  const uids = (viewport?.getActors?.() || [])
    .filter((entry) => isUntaggedSurfaceActor(entry) || entry.representationUID?.startsWith(SURFACE_UID_PREFIX))
    .map((entry) => entry.uid);
  if (uids.length) {
    viewport.removeActors(uids);
    viewport.render?.();
  }
  return uids.length;
}

function volume3dViewports(): any[] {
  const viewports = [];
  for (const engine of getRenderingEngines() || []) {
    for (const viewport of (engine.getViewports?.() || []) as any[]) {
      if (viewport?.type === csEnums.ViewportType.VOLUME_3D) {
        viewports.push(viewport);
      }
    }
  }
  return viewports;
}

// Wraps each 3D viewport's addActor to label new surface actors; removes
// unlabelled ones left from before (cornerstone rebuilds them, labelled).
export function tagSurfaceActors() {
  let removed = false;
  for (const viewport of volume3dViewports()) {
    if (!viewport.__ildSurfaceTagging) {
      viewport.__ildSurfaceTagging = true;
      const addActor = viewport.addActor.bind(viewport);
      viewport.addActor = (entry) => {
        if (entry && isUntaggedSurfaceActor(entry)) {
          const segmentIndex = segmentIndexOfActor(viewport, entry.actor);
          if (segmentIndex) {
            entry = { ...entry, representationUID: `${SURFACE_UID_PREFIX}${segmentIndex}` };
          }
        }
        return addActor(entry);
      };
    }
    const stale = (viewport.getActors?.() || []).filter(isUntaggedSurfaceActor).map((e) => e.uid);
    if (stale.length) {
      viewport.removeActors(stale);
      removed = true;
    }
  }
  if (removed) {
    cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationModified(SEGMENTATION_ID);
  }
}

// Runs on every change of the segmentation, before cornerstone's own 3D
// update (which waits 0.3 s) and before it next draws. Installed once.
let surfaceGuardInstalled = false;
export function installSurfaceGuard() {
  if (surfaceGuardInstalled) {
    return;
  }
  surfaceGuardInstalled = true;
  const events = cornerstoneTools.Enums.Events;
  const guard = (evt: any) => {
    const { segmentationId } = evt.detail || {};
    if (segmentationId && segmentationId !== SEGMENTATION_ID) {
      return;
    }
    try {
      tagSurfaceActors();
      if (evt.type === events.SEGMENTATION_DATA_MODIFIED) {
        ensureSurfaceEntries();
      }
    } catch (e) {
      console.warn('Could not prepare 3D surfaces', e);
    }
  };
  [
    events.SEGMENTATION_DATA_MODIFIED,
    events.SEGMENTATION_MODIFIED,
    events.SEGMENTATION_REPRESENTATION_ADDED,
    events.SEGMENTATION_REPRESENTATION_MODIFIED,
  ]
    .filter(Boolean)
    .forEach((name) => eventTarget.addEventListener(name, guard));
}
installSurfaceGuard();

// 3D view, part 2: cornerstone (2.2.3, polySeg updateSurfaceData) only recomputes the
// surfaces of classes still present after a change - a class that vanished
// entirely (e.g. lung, after loading a merge without it) kept its old 3D
// surface. Empty those, the same way cornerstone empties a surface itself.
// Does nothing unless 3D surfaces exist.
export function clearStaleSurfaces() {
  const segmentation = cornerstoneTools.segmentation.state.getSegmentation(SEGMENTATION_ID);
  const geometryIds = segmentation?.representationData?.Surface?.geometryIds;
  if (!geometryIds?.size) {
    return;
  }
  const present = new Set(
    cornerstoneTools.utilities.segmentation.getUniqueSegmentIndices(SEGMENTATION_ID).map(Number)
  );
  let cleared = false;
  geometryIds.forEach((geometryId, segmentIndex) => {
    if (present.has(Number(segmentIndex))) {
      return;
    }
    const surface = cache.getGeometry(geometryId)?.data as any;
    if (surface && (surface.points?.length || surface.polys?.length)) {
      surface.points = [];
      surface.polys = [];
      cleared = true;
    }
  });
  if (cleared) {
    cornerstoneTools.segmentation.triggerSegmentationEvents.triggerSegmentationModified(SEGMENTATION_ID);
  }
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
    clearStaleSurfaces();
    return;
  }
  for (const z of toWrite) {
    arrays[z].set(data.subarray(z * sliceLength, (z + 1) * sliceLength));
  }
  notifyModified(volume, toWrite);
  clearStaleSurfaces();
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
