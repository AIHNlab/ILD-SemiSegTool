// "Airway Split" tab: splits the current airway segmentation (from the
// nnunet_airways model, or a loaded save) into trachea and bronchi. The work
// happens on the server (backend lib/airway_split.py, using
// lib/trachea_carina_pipeline.py); MonaiLabelPanel.splitAirways sends the
// airway voxels and writes the result back as one undo step.

import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { useActionTab, ActionTabProps } from './useActionTab';
import './BaseTab.css';
import './Preprocessing.css';
import './AirwaySplit.css';

interface AirwaySplitProps extends ActionTabProps {
  // Resolves to the server's summary ({trachea_length_mm, ...}), or null if
  // it failed (already reported).
  onSplit: () => Promise<any>;
}

// Feather-style "git-branch" icon - one trunk splitting in two.
const SplitIcon = () => (
  <svg viewBox="0 0 24 24" width="18px" height="18px" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

// The server's measurements (lib/airway_split.py) as table rows; missing
// values are left out.
const unit = (v, u) => (v == null ? null : `${v} ${u}`);
function rows(r): [string, string][] {
  const both = (a, b) => [a, b].filter(Boolean).join(' · ') || null;
  return [
    ['Trachea', both(unit(r.trachea_length_mm, 'mm'), unit(r.trachea_volume_ml, 'ml'))],
    ['Bronchi', unit(r.bronchi_volume_ml, 'ml')],
    ['Mean area', unit(r.mean_area_mm2, 'mm²')],
    ['Min area', unit(r.min_area_mm2, 'mm²')],
    ['Area 2 cm above carina', unit(r.area_2cm_above_carina_mm2, 'mm²')],
    ['Tracheal index', r.mean_tracheal_index == null ? null : `${r.mean_tracheal_index} (2 cm: ${r.tracheal_index_2cm_above_carina ?? '–'})`],
    ['Saber-sheath', r.saber_sheath == null ? null : r.saber_sheath ? 'Yes (index ≤ 0.67)' : 'No'],
    ['Tortuosity', r.tortuosity == null ? null : String(r.tortuosity)],
  ].filter(([, v]) => v != null) as [string, string][];
}

const AirwaySplit = forwardRef<any, AirwaySplitProps>((props, ref) => {
  const { isBusy, setBusy, onSplit } = props;
  const { tabId, onSelectActionTab } = useActionTab(props);
  const [result, setResult] = useState<any>(null);

  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const run = async () => {
    setBusy(true);
    try {
      setResult(await onSplit());
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
        defaultValue="airwaysplit"
        onClick={onSelectActionTab}
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Airway Split
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <p style={{ fontSize: 'smaller' }}>
          Splits the airways (run <b>nnunet_airways</b> first) into trachea and bronchi.
        </p>
        <button
          className="actionButton preprocessButton"
          onClick={run}
          disabled={isBusy}
        >
          <SplitIcon />
          <span>{isBusy ? 'Splitting…' : 'Split Airways'}</span>
        </button>
        {result && (
          <div className="preprocessStats airwayStats">
            {rows(result).map(([label, value]) => (
              <div className="preprocessStatsRow" key={label}>
                <span className="preprocessStatsLabel">{label}</span>
                <span className="preprocessStatsValue" title={value}>{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

AirwaySplit.displayName = 'AirwaySplit';

export default AirwaySplit;
