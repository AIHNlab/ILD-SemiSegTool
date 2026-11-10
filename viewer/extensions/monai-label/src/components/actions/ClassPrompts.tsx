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
import ModelSelector from '../ModelSelector';
import { useActionTab, ActionTabProps } from './useActionTab';
import { hideNotification, describeError } from '../../utils/GenericUtils';

const ORGAN_PRESETS = {
  organs: [
    'liver', 'bladder', 'colon', 'dudenum', 'esphagus', 'gallbladder',
    'spleen', 'pancreas', 'right kidney', 'right adrenal gland',
    'left adrenal gland', 'stomach', 'left kidney', 'bladder',
    'prostate or uterus', 'rectum', 'small bowel',
  ],
  vascular: [
    'aorta', 'inferior vena cava', 'portal vein and splenic vein',
    'hepatic vessel', 'pulmonary artery', 'left iliac artery',
    'right iliac artery', 'left iliac vena', 'right iliac vena',
  ],
  bones: [
    'vertebrae l5', 'vertebrae l4', 'vertebrae l3', 'vertebrae l2', 'vertebrae l1',
    'vertebrae t12', 'vertebrae t11', 'vertebrae t10', 'vertebrae t9', 'vertebrae t8',
    'vertebrae t7', 'vertebrae t6', 'vertebrae t5', 'vertebrae t4', 'vertebrae t3',
    'vertebrae t2', 'vertebrae t1', 'vertebrae c7', 'vertebrae c6', 'vertebrae c5',
    'vertebrae c4', 'vertebrae c3', 'vertebrae c2', 'vertebrae c1',
    'left rib 1', 'left rib 2', 'left rib 3', 'left rib 4', 'left rib 5',
    'left rib 6', 'left rib 7', 'left rib 8', 'left rib 9', 'left rib 10',
    'left rib 11', 'left rib 12',
    'right rib 1', 'right rib 2', 'right rib 3', 'right rib 4', 'right rib 5',
    'right rib 6', 'right rib 7', 'right rib 8', 'right rib 9', 'right rib 10',
    'right rib 11', 'right rib 12',
    'left humerus', 'right humerus', 'left scapula', 'right scapula',
    'left clavicula', 'right clavicula', 'left femur', 'right femur',
    'left hip', 'right hip', 'sacrum',
  ],
  lungs: [
    'left lung upper lobe', 'left lung lower lobe', 'right lung upper lobe',
    'right lung middle lobe', 'right lung lower lobe', 'trachea', 'heart',
    'heart myocardium', 'left heart atrium', 'left heart ventricle',
    'right heart atrium', 'right heart ventricle',
  ],
  muscles: [
    'left gluteus maximus', 'right gluteus maximus', 'left gluteus medius',
    'right gluteus medius', 'left gluteus minimus', 'right gluteus minimus',
    'left autochthon', 'right autochthon', 'left iliopsoas',
  ],
};

function getModels(info) {
  return Object.keys(info.data.models).filter(
    (m) =>
      info.data.models[m].type === 'segmentation' ||
      info.data.models[m].type === 'vista3d'
  );
}

function getModelOrgans(info, model) {
  const selectedOrgans = {};
  if (model && info.modelLabelNames[model]?.length) {
    for (const label of info.modelLabelNames[model]) {
      if (label !== 'background') {
        selectedOrgans[label] = false;
      }
    }
  }
  return selectedOrgans;
}

function segColorToRgb(s) {
  const c = s ? s.color : [0, 0, 0];
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const ClassPrompts = forwardRef<any, ActionTabProps>((props, ref) => {
  const { info, isBusy, setBusy, updateView, onOptionsConfig, getActiveViewportInfo, onModelUsed } = props;
  const { notification, tabId, resolveModel, segmentInfo, onSelectActionTab } = useActionTab(props);

  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [selectedOrgans, setSelectedOrgans] = useState<Record<string, boolean>>({});

  // MonaiLabelPanel calls these two unconditionally on every action tab's
  // ref when the active tab switches - ClassPrompts has nothing to do on
  // either transition, but still needs to expose the methods so that call
  // doesn't throw.
  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const models = getModels(info);
  const model = resolveModel(models, currentModel);

  // Nothing has been explicitly picked yet - default to the first model's
  // organ list, same as onSelectModel would set once the user actually
  // chooses one. Previously this defaulting happened via a direct state
  // mutation inside render(); doing it as an effect keyed off the resolved
  // model is the hooks-safe equivalent.
  useEffect(() => {
    if (Object.keys(selectedOrgans).length === 0 && model) {
      setSelectedOrgans(getModelOrgans(info, model));
    }
  }, [model]);

  const onSelectModel = (nextModel: string) => {
    setCurrentModel(nextModel);
    setSelectedOrgans(getModelOrgans(info, nextModel));
  };

  const onChangeOrgans = (k: string, evt: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedOrgans((prev) => ({ ...prev, [k]: !!evt.target.checked }));
  };

  const updateOrganSelection = (labelClasses: string[]) => {
    const modelId = resolveModel(models, currentModel);
    const next = {};
    for (const name of Object.keys(selectedOrgans)) {
      next[name] = false;
    }
    for (const clsName of labelClasses) {
      const idx = info.modelLabelToIdxMap[modelId]?.[clsName];
      if (idx) {
        next[clsName] = true;
      }
    }
    setSelectedOrgans(next);
  };

  const onRunInference = async () => {
    if (!model) {
      notification.show({
        title: 'MONAI Label',
        message: 'Something went wrong: Model is not selected',
        type: 'error',
        duration: 10000,
      });
      return;
    }

    const nid = notification.show({
      title: 'MONAI Label - ' + model,
      message: 'Running Class Based Inference...',
      type: 'info',
      autoClose: false,
    });

    const label_names = [];
    const label_classes = [];
    for (const label of Object.keys(selectedOrgans)) {
      if (!selectedOrgans[label]) {
        continue;
      }
      const idx = info.modelLabelToIdxMap[model][label];
      if (idx) {
        label_names.push(label);
        label_classes.push(idx);
      }
    }

    const config = onOptionsConfig();
    const params =
      config && config.infer && config.infer[model] ? config.infer[model] : {};
    params['label_prompt'] = label_classes;

    setBusy(true);
    // Wrapped so a thrown exception (e.g. updateView failing to parse a
    // malformed/error response body) can't skip setBusy(false) - without
    // this, the Run button (disabled while setBusy is true) and busy
    // spinner would stay stuck forever even though the backend request
    // itself already finished.
    try {
      const { displaySet } = getActiveViewportInfo();
      const response = await props.client().infer(model, displaySet.SeriesInstanceUID, params);

      hideNotification(nid, notification);
      if (response.status !== 200) {
        console.error('Class-based inference failed', response);
        notification.show({
          title: 'MONAI Label',
          message: `Class Based Inference failed: ${describeError(response)}`,
          type: 'error',
          duration: 8000,
        });
        return;
      }

      notification.show({
        title: 'MONAI Label',
        message: 'Run Class Based Inference - Successful',
        type: 'success',
        duration: 4000,
      });

      updateView(response, model, label_names, true);
      onModelUsed?.(model);
    } catch (e) {
      console.error('Class-based inference failed', e);
      hideNotification(nid, notification);
      notification.show({
        title: 'MONAI Label',
        message: `Class Based Inference failed: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const display = models.length > 0 ? 'block' : 'none';
  const segInfo = segmentInfo();

  return (
    <div className="tab" style={{ display: display }}>
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
          Class Prompts
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <ModelSelector
          title="Segmentation VISTA"
          models={models}
          currentModel={currentModel}
          onClick={onRunInference}
          onSelectModel={onSelectModel}
          usage={
            <div style={{ fontSize: 'smaller' }}>
              <br />
              <p>Choose following structures or individual classes</p>
            </div>
          }
        />
        <button
          className="tmpActionButton"
          onClick={() => updateOrganSelection(ORGAN_PRESETS.organs)}
          title="Organs"
          style={{ backgroundColor: '#00a4d9', marginRight: '2px' }}
        >
          Organs
        </button>
        <button
          className="tmpActionButton"
          onClick={() => updateOrganSelection(ORGAN_PRESETS.lungs)}
          title="Lung"
          style={{ backgroundColor: '#00a4d9' }}
        >
          Lung/Heart
        </button>
        <button
          className="tmpActionButton"
          onClick={() => updateOrganSelection(ORGAN_PRESETS.vascular)}
          title="Vascular"
          style={{ backgroundColor: '#00a4d9', marginRight: '2px' }}
        >
          Vascular
        </button>
        <button
          className="tmpActionButton"
          onClick={() => updateOrganSelection(ORGAN_PRESETS.bones)}
          title="Bones"
          style={{ backgroundColor: '#00a4d9', marginRight: '2px' }}
        >
          Bones
        </button>
        <button
          className="tmpActionButton"
          onClick={() => updateOrganSelection(ORGAN_PRESETS.muscles)}
          title="Muscles"
          style={{ backgroundColor: '#00a4d9', marginRight: '2px', marginTop: '2px' }}
        >
          Muscles
        </button>

        <br />
        <div className="optionsTableContainer">
          <hr />
          <p>Selected Organ(s):</p>
          <hr />
          <div className="bodyTableContainer">
            <table className="optionsTable">
              <tbody>
                {Object.entries(selectedOrgans).map(([k, v]) => (
                  <tr key={k}>
                    <td>
                      <input
                        type="checkbox"
                        checked={v}
                        onChange={(e) => onChangeOrgans(k, e)}
                      />
                    </td>
                    <td>
                      <span
                        className="segColor"
                        style={{ backgroundColor: segColorToRgb(segInfo[k]) }}
                      />
                    </td>
                    <td>{k}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
});

ClassPrompts.displayName = 'ClassPrompts';

export default ClassPrompts;
