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
import { useActionTab, ActionTabProps } from './useActionTab';
import { hideNotification, describeError } from '../../utils/GenericUtils';
import './BaseTab.css';
import './Preprocessing.css';

// Feather-style "layers" icon - stands in for "the slices of a volume",
// matching the inline-svg convention MonaiLabelPanel.tsx uses for its own
// Save/Load header icons rather than pulling in a fresh icon set.
const LayersIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18px"
    height="18px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

function formatSize(size?: number[]) {
  return size ? size.join('×') : '—';
}

function formatSpacing(spacing?: number[]) {
  return spacing ? spacing.map((s) => s.toFixed(2)).join('×') + ' mm' : '—';
}

const Preprocessing = forwardRef<any, ActionTabProps>((props, ref) => {
  const { isBusy, setBusy, getActiveViewportInfo } = props;
  const { notification, tabId, onSelectActionTab } = useActionTab(props);

  const [result, setResult] = useState<any>(null);

  // Same no-op transition handling as the other action tabs (e.g.
  // RegionalStats) - MonaiLabelPanel calls these unconditionally when the
  // active tab switches.
  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const onPreprocess = async () => {
    const { displaySet } = getActiveViewportInfo();
    if (!displaySet) {
      return;
    }

    const nid = notification.show({
      title: 'MONAI Label',
      message: 'Computing preprocessing preview...',
      type: 'info',
      autoClose: false,
    });

    setBusy(true);
    try {
      const response = await props.client().preprocess_image(displaySet.SeriesInstanceUID);
      hideNotification(nid, notification);

      if (!response || response.status !== 200) {
        notification.show({
          title: 'MONAI Label',
          message: `Failed to compute preprocessing preview: ${describeError(response)}`,
          type: 'error',
          duration: 8000,
        });
        return;
      }

      setResult(response.data);
    } catch (e) {
      hideNotification(nid, notification);
      notification.show({
        title: 'MONAI Label',
        message: `Failed to compute preprocessing preview: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tab">
      <input
        type="radio"
        name="rd"
        id={tabId}
        className="tab-switch"
        defaultValue="preprocessing"
        onClick={onSelectActionTab}
        defaultChecked
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Preprocessing
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <p style={{ fontSize: 'smaller' }}>
          Preview only - Auto-Segmentation already resamples to 1mm isotropic spacing and
          crops to the body bounding box internally before every run, then maps the result
          back onto this image automatically. Nothing here needs to be run first.
        </p>
        <button
          className="actionButton preprocessButton"
          onClick={onPreprocess}
          disabled={isBusy}
        >
          <LayersIcon />
          <span>{isBusy ? 'Computing…' : 'Preview Preprocessing'}</span>
        </button>
        {result && (
          <div className="preprocessStats">
            <div className="preprocessStatsRow preprocessStatsHeader">
              <span className="preprocessStatsLabel" />
              <span className="preprocessStatsValue">Size</span>
              <span className="preprocessStatsValue">Spacing</span>
            </div>
            <div className="preprocessStatsRow">
              <span className="preprocessStatsLabel">Before</span>
              <span className="preprocessStatsValue" title={formatSize(result.original_size)}>
                {formatSize(result.original_size)}
              </span>
              <span
                className="preprocessStatsValue"
                title={formatSpacing(result.original_spacing)}
              >
                {formatSpacing(result.original_spacing)}
              </span>
            </div>
            <div className="preprocessStatsRow">
              <span className="preprocessStatsLabel">After</span>
              <span className="preprocessStatsValue" title={formatSize(result.size)}>
                {formatSize(result.size)}
              </span>
              <span className="preprocessStatsValue" title={formatSpacing(result.spacing)}>
                {formatSpacing(result.spacing)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

Preprocessing.displayName = 'Preprocessing';

export default Preprocessing;
