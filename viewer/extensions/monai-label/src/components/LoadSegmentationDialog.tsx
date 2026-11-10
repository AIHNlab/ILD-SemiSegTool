import React from 'react';
import { Dialog, ButtonEnums } from '@ohif/ui';

export type SavedSegmentation = {
  tag: string;
  model?: string;
  classes?: string[];
  savedAt: Date | null;
};

type Handlers = {
  onLoad: (save: SavedSegmentation) => void;
  onDownload: (save: SavedSegmentation) => void;
  onDelete: (save: SavedSegmentation) => void;
  onLoadFile: () => void;
};

const DIALOG_ID = 'monai-label-load-segmentation';

const rowButton =
  'rounded px-2 py-1 text-sm hover:opacity-80 disabled:opacity-40';

// Lists this series' segmentations saved on the server (newest first), with
// Load / Download / Delete for each, plus loading a .nrrd file from the computer.
function loadSegmentationDialog(uiDialogService, saves: SavedSegmentation[], handlers: Handlers) {
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
            <table className="w-full border-separate" style={{ borderSpacing: '0 6px' }}>
              <thead>
                <tr className="text-left text-sm text-gray-400">
                  <th className="pr-4 font-normal">Saved</th>
                  <th className="pr-4 font-normal">Model</th>
                  <th className="pr-4 font-normal">Classes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {saves.map(save => (
                  <tr key={save.tag} className="align-top">
                    <td className="whitespace-nowrap pr-4">
                      {save.savedAt ? save.savedAt.toLocaleString() : save.tag}
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
                ))}
              </tbody>
            </table>
          )}
        </div>
      ),
    },
  });
}

export default loadSegmentationDialog;
