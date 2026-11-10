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

import { SyntheticEvent, useEffect, useRef, useState } from 'react';
import { eventTarget } from '@cornerstonejs/core';
import { Enums as CornerstoneToolsEnums } from '@cornerstonejs/tools';
import { UIModalService, UINotificationService } from '@ohif/core';
import { currentSegmentsInfo } from '../../utils/SegUtils';
import './BaseTab.css';

export interface ActionTabProps {
  tabIndex: number;
  info?: any;
  client?: () => any;
  updateView?: (...args: any[]) => any;
  setBusy?: (busy: boolean) => void;
  isBusy?: boolean;
  onSelectActionTab: (name: string) => void;
  onOptionsConfig?: () => any;
  getActiveViewportInfo?: () => any;
  servicesManager?: any;
  commandsManager?: any;
  onModelUsed?: (model: string) => void;
}

// Shared setup every action tab needs: one notification/modal service
// instance, a stable DOM id for its radio-tab input, "which model is
// actually selected" resolution, and the live per-class color/segment-index
// registry (segmentInfo) kept fresh via cornerstone3D's SEGMENTATION_MODIFIED
// event. Previously this all lived on a shared BaseTab class every tab
// extended; each tab now calls this hook instead.
export function useActionTab(props: ActionTabProps) {
  const { tabIndex, servicesManager, onSelectActionTab } = props;

  // Lazily create each service exactly once per component instance, the same
  // way the class version's constructor did - a plain useRef(new X()) would
  // construct a new instance on every render just to discard it.
  const notificationRef = useRef<any>(null);
  if (!notificationRef.current) {
    notificationRef.current = new UINotificationService();
  }
  const uiModalServiceRef = useRef<any>(null);
  if (!uiModalServiceRef.current) {
    uiModalServiceRef.current = new UIModalService();
  }

  const tabId = `tab-${tabIndex}`;

  // Whichever tab is shown by default at panel load (currently
  // Auto-Segmentation) can render its very first pass before segments finish
  // being registered/colored - segmentInfo() would then return {} forever
  // after, since nothing else here ever changes to trigger a re-render.
  // Re-rendering whenever cornerstone3D reports the segmentation's metadata
  // (segment list, colors, labels) changed picks up real colors as soon as
  // they exist, regardless of which tab happened to render first.
  const [, setRerenderTick] = useState(0);
  useEffect(() => {
    const bump = () => setRerenderTick((n) => n + 1);
    eventTarget.addEventListener(
      CornerstoneToolsEnums.Events.SEGMENTATION_MODIFIED,
      bump
    );

    // Belt-and-suspenders: rather than betting everything on that one event
    // firing at exactly the right moment (initial segment/color setup could
    // go through a different path than later edits do), just re-render a few
    // times shortly after mount regardless. Cheap, bounded, and self-cancels
    // once it's had its chance.
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      bump();
      if (attempts >= 10) {
        clearInterval(interval);
      }
    }, 300);

    return () => {
      eventTarget.removeEventListener(
        CornerstoneToolsEnums.Events.SEGMENTATION_MODIFIED,
        bump
      );
      clearInterval(interval);
    };
  }, []);

  const segmentInfo = () => {
    // servicesManager can be momentarily undefined on an early/transient
    // render (e.g. right after a hot reload, before the panel has finished
    // wiring props down) - callers that read this unconditionally shouldn't
    // crash the whole tab over it, just show no colors yet until the next
    // render.
    const segmentationService = servicesManager?.services?.segmentationService;
    return segmentationService ? currentSegmentsInfo(segmentationService).info : {};
  };

  // Single source of truth for "which model is actually selected" - falls
  // back to the first model whenever currentModel is unset OR no longer in
  // the list, so callers never need their own "what if it's invalid" branch.
  const resolveModel = (models: string[], currentModel?: string | null) => {
    if (currentModel && models.includes(currentModel)) {
      return currentModel;
    }
    return models.length > 0 ? models[0] : null;
  };

  const handleSelectActionTab = (evt: SyntheticEvent<HTMLInputElement>) => {
    onSelectActionTab(evt.currentTarget.value);
  };

  return {
    notification: notificationRef.current,
    uiModalService: uiModalServiceRef.current,
    tabId,
    resolveModel,
    segmentInfo,
    onSelectActionTab: handleSelectActionTab,
  };
}
