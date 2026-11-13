import React, { useState } from 'react';
import { Dialog, ButtonEnums } from '@ohif/ui';

export type SavedSegmentation = {
  tag: string;
  model?: string;
  classes?: string[];
  savedAt: Date | null;
};

type Handlers = {
  onLoad: (save: SavedSegmentation) => void;
  // Several saves layered into one (the server stacks them by size).
  onLoadMerged: (saves: SavedSegmentation[]) => void;
  onDownload: (save: SavedSegmentation) => void;
  onDelete: (save: SavedSegmentation) => void;
  onLoadFile: () => void;
};

const DIALOG_ID = 'monai-label-load-segmentation';

const rowButton =
  'rounded px-2 py-1 text-sm hover:opacity-80 disabled:opacity-40';

// The list of saves, with a tick box on each for loading several together.
function SavesTable({ saves, handlers, close, run, loadedTags }) {
  // Ticked saves (the server decides the layering - largest underneath).
  // Starts with what's on screen now if that's a merge, so it can be adjusted
  // and loaded again.
  const [picked, setPicked] = useState<string[]>(() =>
    loadedTags.length > 1 ? loadedTags.filter(tag => saves.some(s => s.tag === tag)) : []
  );
  const toggle = (tag: string) =>
    setPicked(p => (p.includes(tag) ? p.filter(t => t !== tag) : [...p, tag]));
  const pickedSaves = picked.map(tag => saves.find(s => s.tag === tag)).filter(Boolean);

  return (
    <>
      <table className="w-full border-separate" style={{ borderSpacing: '0 6px' }}>
        <thead>
          <tr className="text-left text-sm text-gray-400">
            <th className="pr-2 font-normal" title="Tick several to load them together">Merge</th>
            <th className="pr-4 font-normal">Saved</th>
            <th className="pr-4 font-normal">Model</th>
            <th className="pr-4 font-normal">Classes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {saves.map(save => {
            const order = picked.indexOf(save.tag);
            return (
              <tr key={save.tag} className="align-top">
                <td className="whitespace-nowrap pr-2">
                  <label className="flex cursor-pointer items-center gap-1">
                    <input
                      type="checkbox"
                      checked={order >= 0}
                      onChange={() => toggle(save.tag)}
                    />
                  </label>
                </td>
                <td className="whitespace-nowrap pr-4">
                  {save.savedAt ? save.savedAt.toLocaleString() : save.tag}
                  {loadedTags.includes(save.tag) && (
                    <span
                      className="bg-primary-main ml-2 rounded px-1.5 py-0.5 text-xs"
                      title="Currently loaded in the viewer"
                    >
                      loaded
                    </span>
                  )}
                </td>
                <td className="pr-4">{save.model || '-'}</td>
                <td className="pr-4">{save.classes?.length ? save.classes.join(', ') : '-'}</td>
                <td className="whitespace-nowrap">
                  <button className={`${rowButton} bg-primary-main mr-1`} onClick={run(() => handlers.onLoad(save))}>
                    Load
                  </button>
                  <button
                    className={`${rowButton} mr-1 bg-gray-700`}
                    title="Download a copy as a .nrrd file"
                    onClick={() => handlers.onDownload(save)}
                  >
                    Download
                  </button>
                  <button
                    className={`${rowButton} bg-red-800`}
                    onClick={() => {
                      if (window.confirm('Delete this saved segmentation from the server? This cannot be undone.')) {
                        close();
                        handlers.onDelete(save);
                      }
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-3">
        <button
          className={`${rowButton} bg-primary-main`}
          disabled={pickedSaves.length < 2}
          onClick={run(() => handlers.onLoadMerged(pickedSaves))}
        >
          Load selected together ({pickedSaves.length})
        </button>
        <span className="text-sm text-gray-400">
          Tick two or more. Larger segmentations go underneath and more detailed ones on top
          (e.g. lung below the ILD classes, airways on top), whatever order you tick them in.
        </span>
      </div>
    </>
  );
}

// Lists this series' segmentations saved on the server (newest first), with
// Load / Download / Delete for each, plus loading a .nrrd file from the computer.
// loadedTags: the save(s) currently shown in the viewer (marked, and ticked if
// it's a merge).
function loadSegmentationDialog(
  uiDialogService,
  saves: SavedSegmentation[],
  handlers: Handlers,
  loadedTags: string[] = []
) {
  const close = () => uiDialogService.dismiss({ id: DIALOG_ID });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  uiDialogService.create({
    id: DIALOG_ID,
    centralize: true,
    isDraggable: false,
    showOverlay: true,
    content: Dialog,
    contentProps: {
      title: 'Load Segmentation',
      noCloseButton: false,
      onClose: close,
      actions: [
        { id: 'file', text: 'From a file on this computer…', type: ButtonEnums.type.secondary },
        { id: 'cancel', text: 'Close', type: ButtonEnums.type.primary },
      ],
      onSubmit: ({ action }) => {
        close();
        if (action.id === 'file') {
          handlers.onLoadFile();
        }
      },
      body: () => (
        <div className="bg-primary-dark max-h-[60vh] overflow-y-auto p-4 text-white">
          {saves.length === 0 ? (
            <p className="text-gray-400">No segmentations saved on the server for this series yet.</p>
          ) : (
            <SavesTable saves={saves} handlers={handlers} close={close} run={run} loadedTags={loadedTags} />
          )}
        </div>
      ),
    },
  });
}

export default loadSegmentationDialog;
