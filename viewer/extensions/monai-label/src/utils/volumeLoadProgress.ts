import { cache, eventTarget, Enums } from '@cornerstonejs/core';

const TITLE = 'Loading image';
// Volume ids that already have listeners, so repeated Run clicks don't stack them.
const watching = new Set<string>();

function progressMessage(done: number, total: number) {
  if (!total) {
    return 'Downloading slices... Run segmentation once it has finished.';
  }
  const pct = Math.floor((done * 100) / total);
  return `${done} of ${total} slices loaded (${pct}%). Run segmentation once it has finished.`;
}

/**
 * Shows a live "N of M slices loaded" notification for a volume that is still
 * streaming in, and "ready" once it's complete. Called when Run is pressed too
 * early (segmentation needs the whole volume).
 */
export function showVolumeLoadProgress(notification, volumeId: string) {
  const id = `volume-load-${volumeId}`;
  const volume: any = cache.getVolume(volumeId);
  const total = volume?.imageIds?.length ?? 0;
  // framesProcessed is a private field of cornerstone's streaming volume (no
  // public getter in 2.x); fall back to 0 if a future version renames it.
  notification.show({ id, title: TITLE, message: progressMessage(volume?.framesProcessed ?? 0, total), type: 'loading' });

  if (watching.has(volumeId)) {
    return;
  }
  watching.add(volumeId);

  let lastUpdate = 0;
  const onModified = (evt: any) => {
    const d = evt.detail;
    if (d?.volumeId !== volumeId) return;
    const now = Date.now();
    if (now - lastUpdate < 250) return; // one update per slice is too many re-renders
    lastUpdate = now;
    notification.show({ id, title: TITLE, message: progressMessage(d.framesProcessed, d.numberOfFrames), type: 'loading' });
  };
  const onCompleted = (evt: any) => {
    if (evt.detail?.volumeId !== volumeId) return;
    eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);
    eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted);
    watching.delete(volumeId);
    notification.show({
      id,
      title: 'Image loaded',
      message: 'You can run segmentation now.',
      type: 'success',
      duration: 4000,
    });
  };
  eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);
  eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted);
  // Finished between the caller's check and here: the event already fired.
  if (volume?.loadStatus?.loaded) {
    onCompleted({ detail: { volumeId } });
  }
}
