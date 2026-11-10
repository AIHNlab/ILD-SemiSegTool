import { Enums } from '@cornerstonejs/tools';
import annotationHistory from './utils/AnnotationHistory';

// tool groups that ProbeMONAILabel/RectangleROI/PlanarFreehandROI are
// registered on (see modes/monai-label/src/initToolGroups.js)
const TOOL_GROUP_IDS = ['default', 'mpr'];

export default function getCommandsModule({ servicesManager }) {
  const { toolGroupService, viewportGridService } = servicesManager.services;

  const actions = {
    setToolActive: ({ toolName }) => {
      const { viewports } = viewportGridService.getState();
      if (!viewports.size) {
        return;
      }
      TOOL_GROUP_IDS.forEach((toolGroupId) => {
        const toolGroup = toolGroupService.getToolGroup(toolGroupId);
        if (!toolGroup || !toolGroup.hasTool(toolName)) {
          return;
        }
        const activeToolName = toolGroup.getActivePrimaryMouseButtonTool();
        if (activeToolName && activeToolName !== toolName) {
          toolGroup.setToolPassive(activeToolName);
        }
        toolGroup.setToolActive(toolName, {
          bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
        });
      });
    },
    setToolDisable: ({ toolName }) => {
      TOOL_GROUP_IDS.forEach((toolGroupId) => {
        const toolGroup = toolGroupService.getToolGroup(toolGroupId);
        if (!toolGroup || !toolGroup.hasTool(toolName)) {
          return;
        }
        toolGroup.setToolPassive(toolName);
      });
    },
    undoMonaiAnnotation: () => {
      annotationHistory.undo();
    },
    redoMonaiAnnotation: () => {
      annotationHistory.redo();
    },
  };

  const definitions = {
    setToolActive: {
      commandFn: actions.setToolActive,
    },
    setToolDisable: {
      commandFn: actions.setToolDisable,
    },
    undoMonaiAnnotation: {
      commandFn: actions.undoMonaiAnnotation,
    },
    redoMonaiAnnotation: {
      commandFn: actions.redoMonaiAnnotation,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'MONAILabel',
  };
}
