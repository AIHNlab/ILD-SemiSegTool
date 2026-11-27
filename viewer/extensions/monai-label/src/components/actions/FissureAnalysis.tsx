// "Fissure Analysis" tab: after a lobe segmentation (nnunet_lobes), finds the
// fissure planes between the lobes, detects the visible fissures on the CT and
// measures their completeness. The work happens on the server (backend
// lib/fissure_analysis.py, using the scripts in lib/lobes_border/);
// MonaiLabelPanel.analyseFissures sends the lobes and draws the result.

import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { useActionTab, ActionTabProps } from './useActionTab';
import { getLabelColor } from '../../utils/GenericUtils';
import { getSurfaceOpacity, setSurfaceOpacity } from '../../utils/labelmapAccess';
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
  onAnalyse: (options: { isotropic: boolean }) => Promise<any>;
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

// Quality-flag thresholds.
const MAX_SLICE_MM = 1.25;
const MAX_REJECTED = 0.3;

// Is this reconstruction kernel a sharp (lung) kernel? true / false, or null
// when the name isn't recognised. Fissures are thin bright plates - soft
// (mediastinal) kernels blur them, so they are under-detected.
//   Canon/Toshiba: FC5x, FC8x, FL0x lung; FC0x-FC3x soft.
//   Siemens: B/Br/Bl/I/Q/Qr/Hr + number - 50 and up sharp (Br54, Bl57, B70f, I70f).
//   GE: LUNG, BONE(PLUS), EDGE, SHARP, DETAIL sharp; STANDARD, SOFT soft.
//   Philips: L, D, E, YA-YE sharp; A, B, C soft.
export function isLungKernel(kernel?: string | null): boolean | null {
  const k = (kernel || '').split('\\')[0].trim().toUpperCase();
  if (!k) {
    return null;
  }
  if (/LUNG|BONE|EDGE|SHARP|DETAIL|^FC[58]\d|^FL\d|^Y[A-E]|^[LDE]$/.test(k)) {
    return true;
  }
  if (/STANDARD|STND|SOFT|SMOOTH|BODY|BRAIN|MEDIAST|^FC[0-3]\d|^[ABC]$/.test(k)) {
    return false;
  }
  const siemens = k.match(/^[BIQHJ][RLVF]?(\d{2})/);
  if (siemens) {
    return Number(siemens[1]) >= 50;
  }
  return null;
}

// Scan-level warnings (the same for every fissure).
function scanFlags(scan): string[] {
  if (!scan) {
    return [];
  }
  const flags = [];
  if (scan.sliceThicknessMm > MAX_SLICE_MM) {
    flags.push(`Slices are ${+scan.sliceThicknessMm.toFixed(2)} mm thick (> ${MAX_SLICE_MM} mm) - thin fissures blur out`);
  }
  const lung = isLungKernel(scan.kernel);
  if (lung === false) {
    flags.push(`Kernel ${scan.kernel} is not a lung kernel - use the sharp (lung) reconstruction of this scan`);
  } else if (lung === null) {
    flags.push(
      scan.kernel
        ? `Kernel ${scan.kernel} not recognised - check it is the sharp (lung) reconstruction`
        : 'No kernel in the DICOM - check this is the sharp (lung) reconstruction'
    );
  }
  return flags;
}

const u = (v, unit = '') => (v == null ? null : `${v}${unit}`);

// Why a zig-zag metric is missing (backend: fissure_roughness_v2 thresholds).
function missingReason(r, sagittal = false): string {
  if (r.rejected_frac == null) {
    return 'too little visible fissure (< 100 voxels)';
  }
  if (!r.n_windows) {
    return 'visible fissure too small or patchy (needs 10 cm², 20 mm windows)';
  }
  return sagittal ? 'no sagittal stretch ≥ 30 mm' : 'could not be computed';
}

// The three metrics reported by default: [label, value, tooltip].
function mainRows(r): [string, string, string][] {
  return [
    ['Completeness (FI)', u(r.completeness_pct, ' %'), 'Share of the fissure plane with a visible fissure within 3 mm'],
    ['Roughness', u(r.rough_rms_mm, ' mm'), 'RMS deviation of the visible fissure from a smooth sheet (20 mm windows) - primary metric'],
    [
      'Mean |κ| (bend sharpness)',
      u(r.kappa_mean, ' 1/mm'),
      'How sharply the fissure line bends, on average, on sagittal slices - secondary metric',
    ],
  ].map(([label, value, tip]) => [
    label,
    value ?? '—',
    value != null ? tip : `${tip}. Not available: ${missingReason(r, label.startsWith('Mean'))}`,
  ]) as [string, string, string][];
}

// "More details": the other metrics; values that couldn't be computed are left out.
function detailRows(r): [string, string][] {
  return [
    ['Plane area', u(r.plane_area_cm2, ' cm²')],
    ['Visible area', u(r.area_cm2, ' cm²')],
    ['Roughness p95', u(r.rough_p95_mm, ' mm')],
    ['Angular irregularity', u(r.ang_irreg_deg, '°')],
    ['Area excess', u(r.area_excess_pct, ' %')],
    ['Mean |H| (3D)', u(r.meanH_abs, ' 1/mm')],
    ['SD κ (sagittal)', u(r.kappa_sd, ' 1/mm')],
    ['Tortuosity (sagittal)', u(r.tort_endpoints)],
    ['2D roughness (sagittal)', u(r.rough2d_rms_mm, ' mm')],
    ['Patches / windows / segments', r.n_windows == null ? null : `${r.n_patches ?? 1} / ${r.n_windows} / ${r.n_segments ?? 0}`],
    ['Rejected detections', r.rejected_frac == null ? null : `${Math.round(r.rejected_frac * 100)} %`],
    ['Image noise', u(r.noise_hu, ' HU')],
  ].filter(([, v]) => v != null) as [string, string][];
}

function Row({ label, value, title = undefined, warn = false }) {
  return (
    <div className={`preprocessStatsRow${warn ? ' fissureFlag' : ''}`} title={title}>
      <span className="preprocessStatsLabel">{label}</span>
      <span className="preprocessStatsValue">{value}</span>
    </div>
  );
}

const FissureAnalysis = forwardRef<any, FissureAnalysisProps>((props, ref) => {
  const { isBusy, setBusy, onAnalyse } = props;
  const { tabId, onSelectActionTab } = useActionTab(props);
  // Kept by MonaiLabelPanel (props.result), so it is saved and loaded with
  // the segmentation.
  const result = props.result ?? null;
  const setResult = (value: any) => props.onResult?.(value);
  const [isotropic, setIsotropic] = useState(true);
  const [details, setDetails] = useState(false);
  const [opacity, setOpacity] = useState(() => Math.round(getSurfaceOpacity() * 100));
  const onOpacity = (value: number) => {
    setOpacity(value);
    setSurfaceOpacity(value / 100);
  };

  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const run = async () => {
    setBusy(true);
    try {
      setResult(await onAnalyse({ isotropic }));
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
        <label
          className="fissureOption"
          title="Resample the CT and lobes to 0.7 mm cubes before measuring, so the metrics don't depend on the slice spacing. Recommended."
        >
          <input type="checkbox" checked={isotropic} disabled={isBusy} onChange={(e) => setIsotropic(e.target.checked)} />
          <span>Make voxels isotropic first (0.7 mm)</span>
        </label>
        <button className="airwaySplitButton" onClick={run} disabled={isBusy}>
          {isBusy ? <span className="airwaySplitSpinner" /> : <AnalyseIcon />}
          <span>{isBusy ? 'Analysing…' : 'Analyse Fissures'}</span>
        </button>
        <div
          className="brushSizeRow"
          title="3D view: makes the lobes (and other classes) see-through; the fissures stay solid"
        >
          <span className="brushSizeLabel">3D Lobe Opacity</span>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={opacity}
            onChange={(e) => onOpacity(Number(e.target.value))}
            style={{ '--pct': `${((opacity - 5) / 95) * 100}%` } as React.CSSProperties}
          />
          <span className="brushSizeValue">{opacity}%</span>
        </div>
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
            {result.isotropic === false && (
              <Row label="⚠ Not isotropic" value="measured on the scan's own voxels" warn
                title="Re-run with 'Make voxels isotropic first' for comparable metrics" />
            )}
            {scanFlags(result.scan).map((flag) => (
              <Row key={flag} label="⚠ Scan" value={flag} warn />
            ))}
            {FISSURE_CLASSES.map((label, i) => {
              const r = fissures[RESULT_KEYS[i]];
              return (
                <React.Fragment key={label}>
                  <div className="preprocessStatsRow fissureStatsHeader">
                    <span className="segColor" style={{ backgroundColor: color(label) }} />
                    <span>{label}</span>
                  </div>
                  {!r && <Row label="Not evaluable" value="lobe missing" />}
                  {r && r.rejected_frac > MAX_REJECTED && (
                    <Row label="⚠ Detections" value={`${Math.round(r.rejected_frac * 100)} % rejected (> ${MAX_REJECTED * 100} %)`} warn
                      title="Many detected voxels lay off the fitted fissure sheet - metrics may be unreliable" />
                  )}
                  {r && mainRows(r).map(([name, value, tip]) => <Row key={name} label={name} value={value} title={tip} />)}
                  {r && details && detailRows(r).map(([name, value]) => <Row key={name} label={name} value={value} />)}
                </React.Fragment>
              );
            })}
            <button className="fissureDetailsToggle" onClick={() => setDetails(!details)}>
              {details ? 'Hide details' : 'More details'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

FissureAnalysis.displayName = 'FissureAnalysis';

export default FissureAnalysis;
