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

import React from 'react';
import { Dialog, ButtonEnums } from '@ohif/ui';

// Shows what will be saved (auto-filled from the current segmentation
// state - the last model run and whichever classes actually have voxels
// right now) before actually uploading, per the save flow: no manual
// metadata entry, just a confirm step.
function saveSegmentationDialog(uiDialogService, { model, classes }, onConfirm) {
  const dialogId = 'monai-label-save-segmentation';

  uiDialogService.create({
    id: dialogId,
    centralize: true,
    isDraggable: false,
    showOverlay: true,
    content: Dialog,
    contentProps: {
      title: 'Save Segmentation',
      noCloseButton: true,
      onClose: () => uiDialogService.dismiss({ id: dialogId }),
      actions: [
        { id: 'cancel', text: 'Cancel', type: ButtonEnums.type.secondary },
        { id: 'save', text: 'Save', type: ButtonEnums.type.primary },
      ],
      onSubmit: ({ action }) => {
        uiDialogService.dismiss({ id: dialogId });
        if (action.id === 'save') {
          onConfirm();
        }
      },
      body: () => (
        <div className="bg-primary-dark p-4 text-white">
          <table>
            <tbody>
              <tr>
                <td className="pr-4 align-top text-gray-400">Model:</td>
                <td>{model || 'Unknown'}</td>
              </tr>
              <tr>
                <td className="pr-4 align-top text-gray-400">Date/Time:</td>
                <td>{new Date().toLocaleString()}</td>
              </tr>
              <tr>
                <td className="pr-4 align-top text-gray-400">Classes:</td>
                <td>{classes.length ? classes.join(', ') : 'None detected'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ),
    },
  });
}

export default saveSegmentationDialog;
