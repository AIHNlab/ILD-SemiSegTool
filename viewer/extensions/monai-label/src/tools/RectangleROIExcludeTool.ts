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

import { RectangleROITool } from '@cornerstonejs/tools';

// Same box tool, exclude mode: while active, boxes you draw carve that
// region back out of the segmentation instead of adding to it. A distinct
// toolName (not a flag on RectangleROI) so its annotations are tracked and
// styled separately - see init.ts for the color override.
export default class RectangleROIExcludeTool extends RectangleROITool {
  static toolName = 'RectangleROIExclude';
}
