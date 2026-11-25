import { Types } from '@ohif/core';
import { mpr } from './mpr';

// Phones: the MPR protocol's axial view alone, full screen - three views side
// by side are unusable on a ~400px wide screen. Same viewport id/options as
// mpr's axial view (volume viewport, 'mpr' tool group), so segmentation and
// the MONAI Label tools work the same; the Layout button still switches to
// the 3-view MPR.
export const mprSingle: Types.HangingProtocol.Protocol = {
  ...mpr,
  id: 'mprSingle',
  name: 'MPR (axial only)',
  stages: [
    {
      name: 'MPR 1x1',
      viewportStructure: {
        layoutType: 'grid',
        properties: { rows: 1, columns: 1 },
      },
      viewports: [mpr.stages[0].viewports[0]],
    },
  ],
};
