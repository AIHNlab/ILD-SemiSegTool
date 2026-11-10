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

import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

import NextSampleForm from './NextSampleForm';
import { useActionTab, ActionTabProps } from './useActionTab';
import { hideNotification, describeError } from '../../utils/GenericUtils';

const ActiveLearning = forwardRef<any, ActionTabProps>((props, ref) => {
  const { info, isBusy, setBusy, onOptionsConfig } = props;
  const { notification, uiModalService, tabId } = useActionTab(props);

  const [strategy, setStrategy] = useState('random');
  const [training, setTraining] = useState(false);

  // MonaiLabelPanel calls these two unconditionally on every action tab's
  // ref when the active tab switches - Active Learning has nothing to do on
  // either transition, but still needs to expose the methods so that call
  // doesn't throw.
  useImperativeHandle(ref, () => ({
    onEnterActionTab: () => {},
    onLeaveActionTab: () => {},
  }));

  useEffect(() => {
    props.client().is_train_running().then(setTraining);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChangeStrategy = (evt: React.ChangeEvent<HTMLSelectElement>) => {
    setStrategy(evt.target.value);
  };

  const onClickNextSample = async () => {
    const nid = notification.show({
      title: 'MONAI Label',
      message: 'Running Active Learning strategy - ' + strategy,
      type: 'info',
      autoClose: false,
    });

    const config = onOptionsConfig();
    const params =
      config && config.activelearning && config.activelearning[strategy]
        ? config.activelearning[strategy]
        : {};
    setBusy(true);
    const response = await props.client().next_sample(strategy, params);
    setBusy(false);
    hideNotification(nid, notification);

    if (response.status !== 200) {
      console.error('Failed to fetch next sample', response);
      notification.show({
        title: 'MONAI Label',
        message: `Failed to fetch next sample: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
    } else {
      uiModalService.show({
        content: NextSampleForm,
        contentProps: {
          info: response.data,
        },
        shouldCloseOnEsc: true,
        title: 'Active Learning - Next Sample',
        customClassName: 'nextSampleForm',
      });
    }
  };

  const onClickUpdateModel = async () => {
    const config = onOptionsConfig();
    const params = config && config.train ? config.train : {};

    const response = training
      ? await props.client().stop_train()
      : await props.client().run_train(params);

    if (response.status !== 200) {
      console.error('Failed to ' + (training ? 'stop' : 'run') + ' training', response);
      notification.show({
        title: 'MONAI Label',
        message: `Failed to ${training ? 'STOP' : 'RUN'} training: ${describeError(response)}`,
        type: 'error',
        duration: 8000,
      });
    } else {
      notification.show({
        title: 'MONAI Label',
        message: 'Model update task ' + (training ? 'STOPPED' : 'STARTED'),
        type: 'success',
        duration: 2000,
      });
      setTraining(!training);
    }
  };

  const ds = info.data.datastore;
  const completed = ds && ds.completed ? ds.completed : 0;
  const total = ds && ds.total ? ds.total : 1;
  const annotatedPct = Math.round(100 * (completed / total)) + '%';
  const annotatedTip = completed + '/' + total + ' samples annotated';

  const ts = info.data.train_stats ? Object.values(info.data.train_stats)[0] : null;

  const epochs = ts ? (ts.total_time ? 0 : ts.epoch ? ts.epoch : 1) : 0;
  const totalEpochs = ts && ts.total_epochs ? ts.total_epochs : 1;
  const trainingPct = Math.round(100 * (epochs / totalEpochs)) + '%';
  const trainingTip = epochs ? epochs + '/' + totalEpochs + ' epochs completed' : 'Not Running';

  const accuracy = ts && ts.best_metric ? Math.round(100 * ts.best_metric) + '%' : '0%';
  const accuracyTip = ts && ts.best_metric ? accuracy + ' is current best metric' : 'not determined';

  const strategies = info.data.strategies ? info.data.strategies : {};

  return (
    <div className="tab">
      <input
        className="tab-switch"
        type="checkbox"
        id={tabId}
        name="activelearning"
        defaultValue="activelearning"
      />
      <label className="tab-label" htmlFor={tabId}>
        <span className="tabLabelText">
          Active Learning
          {isBusy && <span className="tabBusyIndicator" title="Running…" />}
        </span>
      </label>
      <div className="tab-content">
        <table style={{ fontSize: 'smaller', width: '100%' }}>
          <tbody>
            <tr>
              <td>
                <button
                  className="actionInput"
                  style={{ backgroundColor: 'lightgray' }}
                  onClick={onClickNextSample}
                >
                  Next Sample
                </button>
              </td>
              <td>&nbsp;</td>
              <td>
                <button
                  className="actionInput"
                  style={{ backgroundColor: 'lightgray' }}
                  onClick={onClickUpdateModel}
                >
                  {training ? 'Stop Training' : 'Update Model'}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <br />

        <table className="optionsTable">
          <tbody>
            <tr>
              <td>Strategy:</td>
              <td width="80%">
                <select
                  className="actionInput"
                  onChange={onChangeStrategy}
                  value={strategy}
                >
                  {Object.keys(strategies).map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td colSpan={2}>&nbsp;</td>
            </tr>
            <tr>
              <td>Annotated:</td>
              <td width="80%" title={annotatedTip}>
                <div className="w3-round w3-light-grey w3-tiny">
                  <div
                    className="w3-round w3-container w3-blue w3-center"
                    style={{ backgroundColor: 'white' }}
                  >
                    {annotatedPct}
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <td>Training:</td>
              <td title={trainingTip}>
                <div className="w3-round w3-light-grey w3-tiny">
                  <div
                    className="w3-round w3-container w3-orange w3-center"
                    style={{ backgroundColor: 'white' }}
                  >
                    {trainingPct}
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <td>Train Acc:</td>
              <td title={accuracyTip}>
                <div className="w3-round w3-light-grey w3-tiny">
                  <div
                    className="w3-round w3-container w3-green w3-center"
                    style={{ backgroundColor: 'white' }}
                  >
                    {accuracy}
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
});

ActiveLearning.displayName = 'ActiveLearning';

export default ActiveLearning;
