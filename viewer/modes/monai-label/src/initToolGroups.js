const colours = {
  'viewport-0': 'rgb(200, 0, 0)',
  'viewport-1': 'rgb(200, 200, 0)',
  'viewport-2': 'rgb(0, 200, 0)',
};

const colorsByOrientation = {
  axial: 'rgb(200, 0, 0)',
  sagittal: 'rgb(200, 200, 0)',
  coronal: 'rgb(0, 200, 0)',
};

// Touch-only device (phone/tablet, no mouse): there is no wheel to scroll
// slices, so one finger scrolls them by default (window/level is still one
// tap away on the toolbar). On every device: two-finger pinch zooms, three
// fingers pan.
const isTouchOnly = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(pointer: coarse)').matches &&
  !window.matchMedia('(any-pointer: fine)').matches;

function createTools(utilityModule) {
  const { toolNames, Enums } = utilityModule.exports;
  const touchOnly = isTouchOnly();
  const primary = { mouseButton: Enums.MouseBindings.Primary };
  return {
    active: [
      { toolName: toolNames.WindowLevel, bindings: touchOnly ? [] : [primary] },
      { toolName: toolNames.Pan, bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }, { numTouchPoints: 3 }] },
      { toolName: toolNames.Zoom, bindings: [{ mouseButton: Enums.MouseBindings.Secondary }, { numTouchPoints: 2 }] },
      {
        toolName: toolNames.StackScroll,
        bindings: [{ mouseButton: Enums.MouseBindings.Wheel }, ...(touchOnly ? [primary] : [])],
      },
    ],
    passive: [
      {
        toolName: 'CircularBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'FILL_INSIDE_CIRCLE',
          // Default (25) is a 50mm-diameter circle - way too coarse for
          // picking out a small lesion/pattern on a CT slice. 5 gives a
          // 10mm-diameter circle, small enough for precise touch-ups.
          brushSize: 5,
        },
      },
      {
        toolName: 'CircularEraser',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'ERASE_INSIDE_CIRCLE',
          brushSize: 5,
        },
      },
      {
        toolName: 'SphereBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'FILL_INSIDE_SPHERE',
        },
      },
      {
        toolName: 'SphereEraser',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'ERASE_INSIDE_SPHERE',
        },
      },
      {
        toolName: 'ThresholdCircularBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
        },
      },
      {
        toolName: 'ThresholdSphereBrush',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_SPHERE',
        },
      },
      {
        toolName: 'ThresholdCircularBrushDynamic',
        parentTool: 'Brush',
        configuration: {
          activeStrategy: 'THRESHOLD_INSIDE_CIRCLE',
          // preview: {
          //   enabled: true,
          // },
          strategySpecificConfiguration: {
            // to use the use the center segment index to determine
            // if inside -> same segment, if outside -> eraser
            // useCenterSegmentIndex: true,
            THRESHOLD: {
              isDynamic: true,
              dynamicRadius: 3,
            },
          },
        },
      },
      { toolName: toolNames.CircleScissors },
      { toolName: toolNames.RectangleScissors },
      { toolName: toolNames.SphereScissors },
      { toolName: toolNames.StackScroll },
      { toolName: toolNames.Magnify },
      { toolName: toolNames.WindowLevelRegion },

      { toolName: toolNames.UltrasoundDirectional },
      { toolName: 'ProbeMONAILabel' },
      { toolName: 'ProbeMONAILabelExclude' },
      { toolName: toolNames.RectangleROI },
      { toolName: toolNames.PlanarFreehandROI },
      { toolName: 'RectangleROIExclude' },
      { toolName: 'PlanarFreehandROIExclude' }
    ],
    disabled: [{ toolName: toolNames.ReferenceLines }, { toolName: toolNames.AdvancedMagnify }],
  };
}

function initDefaultToolGroup(extensionManager, toolGroupService, commandsManager, toolGroupId) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );
  const tools = createTools(utilityModule);
  toolGroupService.createToolGroupAndAddTools(toolGroupId, tools);
}

function initMPRToolGroup(extensionManager, toolGroupService, commandsManager) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );
  const servicesManager = extensionManager._servicesManager;
  const { cornerstoneViewportService } = servicesManager.services;
  const tools = createTools(utilityModule);
  tools.disabled.push(
    {
      toolName: utilityModule.exports.toolNames.Crosshairs,
      configuration: {
        viewportIndicators: true,
        viewportIndicatorsConfig: {
          circleRadius: 5,
          xOffset: 0.95,
          yOffset: 0.05,
        },
        disableOnPassive: true,
        autoPan: {
          enabled: false,
          panSize: 10,
        },
        getReferenceLineColor: viewportId => {
          const viewportInfo = cornerstoneViewportService.getViewportInfo(viewportId);
          const viewportOptions = viewportInfo?.viewportOptions;
          if (viewportOptions) {
            return (
              colours[viewportOptions.id] ||
              colorsByOrientation[viewportOptions.orientation] ||
              '#0c0'
            );
          } else {
            console.warn('missing viewport?', viewportId);
            return '#0c0';
          }
        },
      },
    },
    { toolName: utilityModule.exports.toolNames.ReferenceLines }
  );
  toolGroupService.createToolGroupAndAddTools('mpr', tools);
}

function initVolume3DToolGroup(extensionManager, toolGroupService) {
  const utilityModule = extensionManager.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.tools'
  );

  const { toolNames, Enums } = utilityModule.exports;

  const tools = {
    active: [
      {
        toolName: toolNames.TrackballRotateTool,
        bindings: [{ mouseButton: Enums.MouseBindings.Primary }],
      },
      {
        toolName: toolNames.Zoom,
        bindings: [{ mouseButton: Enums.MouseBindings.Secondary }],
      },
      {
        toolName: toolNames.Pan,
        bindings: [{ mouseButton: Enums.MouseBindings.Auxiliary }],
      },
    ],
  };

  toolGroupService.createToolGroupAndAddTools('volume3d', tools);
}

function initToolGroups(extensionManager, toolGroupService, commandsManager) {
  initDefaultToolGroup(extensionManager, toolGroupService, commandsManager, 'default');
  initMPRToolGroup(extensionManager, toolGroupService, commandsManager);
  initVolume3DToolGroup(extensionManager, toolGroupService);
}

export default initToolGroups;
