// "Fissure Analysis" tab: after a lobe segmentation (nnunet_lobes), finds the
// fissure planes between the lobes, detects the visible fissures on the CT and
// measures their completeness. The work happens on the server (backend
// lib/fissure_analysis.py, using the scripts in lib/lobes_border/);
// MonaiLabelPanel.analyseFissures sends the lobes and draws the result.

import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { useActionTab, ActionTabProps } from './useActionTab';
import { getLabelColor } from '../../utils/GenericUtils';
import './BaseTab.css';
import './Preprocessing.css';
import './AirwaySplit.css';

// The lobe classes in the order the server numbers them (1..5 - the lobe
// model's own order, backend lib/configs/nnunet_lobes.py).
export const LOBE_CLASSES = [
  'Left upper lobe (LUL)',
  'Left lower lobe (LLL)',
  'Right upper lobe (RUL)',
  'Right middle lobe (RML)',
  'Right lower lobe (RLL)',
];
// The detected fissures, in the server's order (1..3).
export const FISSURE_CLASSES = ['Left oblique fissure', 'Right oblique fissure', 'Right horizontal fissure'];
const RESULT_KEYS = ['left_oblique', 'right_oblique', 'right_horizontal'];

interface FissureAnalysisProps extends ActionTabProps {
  // Resolves to the server's results ({fissures: {left_oblique: {...}}}), or
  // null if it failed (already reported).
  onAnalyse: () => Promise<any>;
}

function color(label) {
  const { r, g, b } = getLabelColor(label);
  return `rgb(${r}, ${g}, ${b})`;
}

// Feather-style "activity" icon - a measured trace.
const AnalyseIcon = () => (
  <svg viewBox="0 0 24 24" width="16px" height="16px" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

// One fissure's results (backend lib/fissure_analysis.py) as table rows;
// values that couldn't be computed are left out.
function resultRows(r): [string, string][] {
  const u = (v, unit = '') => (v == null ? null : `${v}${unit}`);
  return [
    ['Completeness (FI)', u(r.completeness_pct, ' %')],
    ['Plane area', u(r.plane_area_cm2, ' cm²')],
    ['Roughness RMS', u(r.rough_rms_mm, ' mm')],
    ['Roughness p95', u(r.rough_p95_mm, ' mm')],
    ['Angular irregularity', u(r.ang_irreg_deg, '°')],
    ['Area excess', u(r.area_excess_pct, ' %')],
    ['Mean |H| (3D)', u(r.meanH_abs, ' /mm')],
    ['Mean |κ| (sagittal)', u(r.kappa_mean, ' /mm')],
    ['Tortuosity (sagittal)', u(r.tort_endpoints)],
    ['Rejected detections', r.rejected_frac == null ? null : `${Math.round(r.rejected_frac * 100)} %`],
    ['Image noise', u(r.noise_hu, ' HU')],
  ].filter(([, v]) => v != null) as [string, string][];
}

const FissureAnalysis = forwardRef<any, FissureAnalysisProps>((props, ref) => {
  const { isBusy, setBusy, onAnalyse } = props;
  const { tabId, onSelectActionTab } = useActionTab(props);
  const [result, setResult] = useState<any>(null);

  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const run = async () => {
    setBusy(true);
    try {
      setResult(await onAnalyse());
    } finally {
      setBusy(false);
    }
  };

  const fissures = result?.fissures || {};
  return (
    <div className="tab">
      <input
        type="radio"
        name="rd"
        id={tabId}
        className="tab-switch"
        defaultValue="fissures"
        onClick={onSelectActionTab}
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Fissure Analysis
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <p style={{ fontSize: 'smaller' }}>
          Detects the fissures between the lobes (run <b>nnunet_lobes</b> first) and measures
          their completeness.
        </p>
        <button className="airwaySplitButton" onClick={run} disabled={isBusy}>
          {isBusy ? <span className="airwaySplitSpinner" /> : <AnalyseIcon />}
          <span>{isBusy ? 'Analysing…' : 'Analyse Fissures'}</span>
        </button>
        <div className="optionsTableContainer">
          <hr />
          <p>Classes:</p>
          <hr />
          <div className="bodyTableContainer">
            <table className="optionsTable">
              <tbody>
                {FISSURE_CLASSES.map((label) => (
                  <tr key={label}>
                    <td>
                      <span className="segColor" style={{ backgroundColor: color(label) }} />
                    </td>
                    <td>{label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {result && (
          <div className="preprocessStats airwayStats">
            {FISSURE_CLASSES.map((label, i) => {
              const r = fissures[RESULT_KEYS[i]];
              const rows = r ? resultRows(r) : [['Not evaluable', 'lobe missing']];
              return (
                <React.Fragment key={label}>
                  <div className="preprocessStatsRow fissureStatsHeader">
                    <span className="segColor" style={{ backgroundColor: color(label) }} />
                    <span>{label}</span>
                  </div>
                  {rows.map(([name, value]) => (
                    <div className="preprocessStatsRow" key={name}>
                      <span className="preprocessStatsLabel">{name}</span>
                      <span className="preprocessStatsValue">{value}</span>
                    </div>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

FissureAnalysis.displayName = 'FissureAnalysis';

export default FissureAnalysis;
