import { addTool, RectangleROITool, PlanarFreehandROITool, annotation } from '@cornerstonejs/tools';
import { Types } from '@ohif/core';
import ProbeMONAILabelTool from './tools/ProbeMONAILabelTool';
import ProbeMONAILabelExcludeTool from './tools/ProbeMONAILabelExcludeTool';
import RectangleROIExcludeTool from './tools/RectangleROIExcludeTool';
import PlanarFreehandROIExcludeTool from './tools/PlanarFreehandROIExcludeTool';
import './utils/AnnotationHistory';

// tool groups that the MONAI Label tools are registered on (see
// modes/monai-label/src/initToolGroups.js) - matches TOOL_GROUP_IDS there
const TOOL_GROUP_IDS = ['default', 'mpr'];
const EXCLUDE_COLOR = 'rgb(255, 60, 60)';
const EXCLUDE_STYLE = {
  RectangleROIExclude: { color: EXCLUDE_COLOR, colorHighlighted: EXCLUDE_COLOR },
  PlanarFreehandROIExclude: { color: EXCLUDE_COLOR, colorHighlighted: EXCLUDE_COLOR },
};

/**
 * @param {object} configuration
 */
export default function init({
  servicesManager,
  configuration = {},
}: Types.Extensions.ExtensionParams): void {
  addTool(ProbeMONAILabelTool);
  addTool(ProbeMONAILabelExcludeTool);
  addTool(RectangleROITool);
  addTool(PlanarFreehandROITool);
  addTool(RectangleROIExcludeTool);
  addTool(PlanarFreehandROIExcludeTool);

  // Rectangle/freehand exclude tools reuse the stock tools' own rendering
  // (unlike ProbeMONAILabelExcludeTool, which draws its own marker), so
  // their red styling has to go through cornerstone's per-toolGroup style
  // config instead of a custom color prop.
  TOOL_GROUP_IDS.forEach((toolGroupId) => {
    annotation.config.style.setToolGroupToolStyles(toolGroupId, EXCLUDE_STYLE);
  });
}
