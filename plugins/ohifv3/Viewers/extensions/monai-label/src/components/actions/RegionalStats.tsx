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
import { hideNotification, describeError, getLabelColor } from '../../utils/GenericUtils';
import './BaseTab.css';
import './RegionalStats.css';

// Not a real segmentation class (see radiology/lib/regional_stats.py's
// "unclassified" bucket) so it has no entry in the app's shared anatomy
// color table - pick a neutral, deliberately muted gray instead of letting
// getLabelColor() hash it to an arbitrary color.
const UNCLASSIFIED_COLOR = 'rgb(90, 100, 110)';

// getLabelColor() is the same lookup MonaiLabelPanel.segmentColor() uses for
// the actual on-screen segmentation overlay, so a class's color here always
// matches its color everywhere else in the viewer.
function classColor(name: string): string {
  if (name === 'unclassified') {
    return UNCLASSIFIED_COLOR;
  }
  const { r, g, b } = getLabelColor(name);
  return `rgb(${r}, ${g}, ${b})`;
}

function formatPercent(value: number | null) {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A single 100%-stacked horizontal bar for one region: one colored segment
// per class, width proportional to its % of that region's lung volume, in
// the same fixed class order everywhere (never re-sorted by value - color
// must always mean the same class at a glance). A 2px dark gap between
// segments (regionalStatsBarSegment's border-right) keeps adjacent similar
// hues (e.g. reticulation/consolidation) visually separable, and every
// segment carries a native title tooltip with the exact number, since color
// proximity alone isn't reliable for that pair.
function RegionBar({ classPercent, columns }) {
  return (
    <div className="regionalStatsBar">
      {columns.map((name) => {
        const pct = classPercent[name];
        if (!pct) {
          return null;
        }
        return (
          <div
            key={name}
            className="regionalStatsBarSegment"
            title={`${cap(name)}: ${pct.toFixed(1)}%`}
            style={{ width: `${pct}%`, backgroundColor: classColor(name) }}
          />
        );
      })}
    </div>
  );
}

function RegionRow({ region, columns, expanded, onToggle }) {
  const isEmpty = !region.lung_volume_ml;
  return (
    <div className="regionalStatsRegionRow">
      <div className="regionalStatsRegionHeader clickable-row" onClick={onToggle}>
        <span className="regionalStatsChevron">{expanded ? '▾' : '▸'}</span>
        <span className="regionalStatsRegionLabel">{cap(region.depth)}</span>
        {isEmpty ? (
          <div className="regionalStatsBarEmpty" title="No lung tissue in this region" />
        ) : (
          <RegionBar classPercent={region.class_percent} columns={columns} />
        )}
        <span className="regionalStatsVolume">{region.lung_volume_ml.toFixed(1)} mL</span>
      </div>
      {expanded && (
        <div className="regionalStatsDetails">
          {isEmpty ? (
            <div>No lung tissue in this region.</div>
          ) : (
            columns.map(
              (name) =>
                !!region.class_percent[name] && (
                  <div className="regionalStatsDetailRow" key={name}>
                    <span
                      className="segColor"
                      style={{ backgroundColor: classColor(name), height: 10, width: 10 }}
                    />
                    <span>
                      {cap(name)}: {formatPercent(region.class_percent[name])}
                    </span>
                  </div>
                )
            )
          )}
        </div>
      )}
    </div>
  );
}

const RegionalStats = forwardRef<any, ActionTabProps>((props, ref) => {
  const { isBusy, setBusy, getActiveViewportInfo } = props;
  const { notification, tabId, onSelectActionTab } = useActionTab(props);

  const [result, setResult] = useState<any>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showTable, setShowTable] = useState(false);

  // Same no-op transition handling as the other action tabs (e.g.
  // AutoSegmentation) - MonaiLabelPanel calls these unconditionally when the
  // active tab switches.
  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  const onCompute = async () => {
    const { displaySet } = getActiveViewportInfo();
    if (!displaySet) {
      return;
    }

    const nid = notification.show({
      title: 'MONAI Label',
      message: 'Computing regional statistics...',
      type: 'info',
      autoClose: false,
    });

    setBusy(true);
    try {
      const response = await props.client().regional_stats(displaySet.SeriesInstanceUID);
      hideNotification(nid, notification);

      if (!response || response.status !== 200) {
        notification.show({
          title: 'MONAI Label',
          message: `Failed to compute regional statistics: ${describeError(response)}`,
          type: 'error',
          duration: 8000,
        });
        return;
      }

      setResult(response.data);
      setExpanded({});
    } catch (e) {
      hideNotification(nid, notification);
      notification.show({
        title: 'MONAI Label',
        message: `Failed to compute regional statistics: ${describeError(e)}`,
        type: 'error',
        duration: 8000,
      });
    } finally {
      setBusy(false);
    }
  };

  const columns = result?.regions?.length ? Object.keys(result.regions[0].class_percent) : [];

  const regionKey = (r) => `${r.side}-${r.zone}-${r.depth}`;
  const toggleRegion = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="tab">
      <input
        type="radio"
        name="rd"
        id={tabId}
        className="tab-switch"
        defaultValue="regionalstats"
        onClick={onSelectActionTab}
      />
      <label htmlFor={tabId} className="tab-label">
        <span className="tabLabelText">
          Regional Stats
          {isBusy && <span className="tabBusyIndicator" title="Computing…" />}
        </span>
      </label>
      <div className="tab-content">
        <p style={{ fontSize: 'smaller' }}>
          Combines the latest saved lung + ILD-class segmentations into
          12-region (side / zone / depth) volumetric statistics.
        </p>
        <button className="actionButton" onClick={onCompute} disabled={isBusy}>
          Compute Regional Stats
        </button>
        {result && (
          <>
            <p className="regionalStatsCaption">
              Computed from lung=<b>{result.lung_tag}</b>, ILD=<b>{result.ild_tag}</b> (peripheral
              &nbsp;≤&nbsp;{result.peripheral_distance_mm}mm)
            </p>
            <button
              className="regionalStatsViewToggle"
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable ? 'Show as bars' : 'Show as table'}
            </button>

            {showTable ? (
              <div className="bodyTableContainer">
                <table className="optionsTable">
                  <thead>
                    <tr>
                      <th>Region</th>
                      <th>Lung Vol (mL)</th>
                      {columns.map((c) => (
                        <th key={c}>{cap(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.regions.map((region, i) => (
                      <tr key={i}>
                        <td>
                          {cap(region.side)} / {cap(region.zone)} / {cap(region.depth)}
                        </td>
                        <td>{region.lung_volume_ml.toFixed(1)}</td>
                        {columns.map((c) => (
                          <td key={c}>{formatPercent(region.class_percent[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                {['left', 'right'].map((side) => (
                  <div className="regionalStatsSide" key={side}>
                    <div className="regionalStatsSideTitle">{cap(side)} Lung</div>
                    {['upper', 'middle', 'lower'].map((zone) => {
                      const regions = result.regions.filter(
                        (r) => r.side === side && r.zone === zone
                      );
                      return (
                        <div className="regionalStatsZone" key={zone}>
                          <div className="regionalStatsZoneTitle">{cap(zone)}</div>
                          {regions.map((region) => {
                            const key = regionKey(region);
                            return (
                              <RegionRow
                                key={key}
                                region={region}
                                columns={columns}
                                expanded={!!expanded[key]}
                                onToggle={() => toggleRegion(key)}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                ))}

                <div className="regionalStatsLegend">
                  {columns.map((name) => (
                    <span className="regionalStatsLegendItem" key={name}>
                      <span
                        className="segColor"
                        style={{ backgroundColor: classColor(name), height: 10, width: 10 }}
                      />
                      {cap(name)}
                    </span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
});

RegionalStats.displayName = 'RegionalStats';

export default RegionalStats;
