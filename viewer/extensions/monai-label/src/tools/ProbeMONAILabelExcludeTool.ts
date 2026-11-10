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

import ProbeMONAILabelBaseTool from './ProbeMONAILabelBaseTool';

// Negative/exclude point - placed alongside a box, freehand, or point prompt
// to carve that spot back out of the resulting segmentation, instead of
// marking where the finding is. A separate tool (not a modifier on
// ProbeMONAILabel) so both kinds can coexist and be told apart on screen -
// red here vs. ProbeMONAILabelTool's default color for "include" points.
// Rendering itself is shared via ProbeMONAILabelBaseTool.
export default class ProbeMONAILabelExcludeTool extends ProbeMONAILabelBaseTool {
  static toolName = 'ProbeMONAILabelExclude';

  constructor(
    toolProps = {},
    defaultToolProps = {
      configuration: {
        customColor: 'rgb(255, 60, 60)',
      },
    }
  ) {
    super(toolProps, defaultToolProps);
  }
}
