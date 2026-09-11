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

import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { cache } from '@cornerstonejs/core';
import ModelSelector from '../ModelSelector';
import { useActionTab, ActionTabProps } from './useActionTab';
import { hideNotification, getLabelColor, describeError } from '../../utils/GenericUtils';

function getModels(info) {
  return Object.keys(info.data.models).filter(
    (m) =>
      info.data.models[m].type === 'segmentation' ||
      info.data.models[m].type === 'vista3d'
  );
}

function getModelLabels(info, model) {
  const names = (model && info.modelLabelNames[model]) || [];
  return names.filter((name) => name !== 'background');
}

// Unlike segmentInfo() (the live registry, empty until a class has actually
// been segmented at least once), getLabelColor is a pure function of the
// label name - the same one MonaiLabelPanel uses to assign each class's
// color in the first place, so this shows the real eventual color for every
// class immediately, with nothing needing to have run yet.
function segColorToRgb(label) {
  const { r, g, b } = getLabelColor(label);
  return `rgb(${r}, ${g}, ${b})`;
}

const AutoSegmentation = forwardRef<any, ActionTabProps>((props, ref) => {
  const { info, isBusy, setBusy, updateView, onOptionsConfig, getActiveViewportInfo, onModelUsed } = props;
  const { notification, tabId, resolveModel, onSelectActionTab } = useActionTab(props);

  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // MonaiLabelPanel calls these two unconditionally on every action tab's
  // ref when the active tab switches - AutoSegmentation has nothing to do on
  // either transition, but still needs to expose the methods so that call
  // doesn't throw.
  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const onSelectModel = (model: string) => {
    setCurrentModel(model);
  };

  const onSegmentation = async () => {
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

    const volumeId = `${displaySet.volumeLoaderSchema}:${displaySet.displaySetInstanceUID}`;
    const volume = cache.getVolume(volumeId);
    if (!volume || !volume.loadStatus?.loaded) {
      notification.show({
        title: 'MONAI Label',
        message: 'Please wait for the image to finish loading before running segmentation',
        type: 'warning',
        duration: 4000,
      });
      return;
    }

    const nid = notification.show({
      title: 'MONAI Label - ' + model,
      message: 'Running Auto-Segmentation...',
      type: 'info',
      autoClose: false,
    });

    const config = onOptionsConfig();
    const params =
      config && config.infer && config.infer[model] ? config.infer[model] : {};
    const label_names = info.modelLabelNames[model];
    const label_classes = info.modelLabelIndices[model];
    if (info.data.models[model].type === 'vista3d') {
      const bodyComponents = [
        'kidney',
        'lung',
        'bone',
        'lung tumor',
        'uterus',
        'postcava',
      ];
      const exclusionValues = bodyComponents.map(
        (cls_name) => info.modelLabelToIdxMap[model][cls_name]
      );
      const filteredLabelClasses = label_classes.filter(
        (value) => !exclusionValues.includes(value)
      );
      params['label_prompt'] = filteredLabelClasses;
    }

    setBusy(true);
    // Wrapped so a thrown exception (e.g. updateView failing to parse a
    // malformed/error response body) can't skip setBusy(false) - without
    // this, the Run button (disabled while setBusy is true) and busy
    // spinner would stay stuck forever even though the backend request
    // itself already finished.
    try {
      const response = await props.client().infer(model, displaySet.SeriesInstanceUID, params);

      hideNotification(nid, notification);
      if (response.status !== 200) {
        console.error('Auto-Segmentation inference failed', response);
        notification.show({
          title: 'MONAI Label - ' + model,
          message: `Segmentation failed: ${describeError(response)}`,
          type: 'error',
          duration: 8000,
        });
        return;
      }

      notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Running Segmentation - Successful',
        type: 'success',
        duration: 4000,
      });

      updateView(response, model, label_names);
      onModelUsed?.(model);
    } catch (e) {
      console.error('Auto-Segmentation inference failed', e);
      hideNotification(nid, notification);
      notification.show({
        title: 'MONAI Label - ' + model,
        message: `Segmentation failed: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const models = getModels(info);
  // ModelSelector defaults to the first model until the user changes it
  // without telling this component - mirror that default here too, so the
  // class list matches what Run will actually use.
  const model = resolveModel(models, currentModel);
  const labels = getModelLabels(info, model);

  return (
    <div className="tab">
      <input
        type="radio"
        name="rd"
        id={tabId}
        className="tab-switch"
        defaultValue="segmentation"
        onClick={onSelectActionTab}
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Auto-Segmentation
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <ModelSelector
          title="Segmentation"
          models={models}
          currentModel={currentModel}
          onClick={onSegmentation}
          onSelectModel={onSelectModel}
          usage={
            <div style={{ fontSize: 'smaller' }}>
              <br />
              <p>
                Experience fully automated segmentation for <b>everything</b> from
                the pre-trained model.
              </p>
            </div>
          }
        />
        {labels.length > 0 && (
          <div className="optionsTableContainer">
            <hr />
            <p>Classes:</p>
            <hr />
            <div className="bodyTableContainer">
              <table className="optionsTable">
                <tbody>
                  {labels.map((label) => (
                    <tr key={label}>
                      <td>
                        <span
                          className="segColor"
                          style={{ backgroundColor: segColorToRgb(label) }}
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

AutoSegmentation.displayName = 'AutoSegmentation';

export default AutoSegmentation;
