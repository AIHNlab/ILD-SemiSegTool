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

import axios from 'axios';

export default class MonaiLabelClient {
  constructor(server_url) {
    this.server_url = new URL(server_url);
  }

  async info() {
    let url = new URL('info/', this.server_url);
    return await MonaiLabelClient.api_get(url.toString());
  }

  async infer(model, image, params, result_extension = '.nrrd', output='image') {
    console.log('Running Infer for: ', { model, image, params, result_extension, output });

    let url = new URL('infer/' + encodeURIComponent(model), this.server_url);
    url.searchParams.append('image', image);
    url.searchParams.append('output', output);
    url = url.toString();

    if (result_extension) {
      params.result_extension = result_extension;
      params.result_dtype = 'uint8';
      params.result_compress = false;
    }

    // return the indexes as defined in the config file
    params.restore_label_idx = false;

    return await MonaiLabelClient.api_post(
      url,
      params,
      null,
      true,
      'arraybuffer'
    );
  }

  async next_sample(strategy = 'random', params = {}) {
    const url = new URL(
      'activelearning/' + encodeURIComponent(strategy),
      this.server_url
    ).toString();

    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async save_label(image, label, params, tag = 'final') {
    let url = new URL('datastore/label', this.server_url);
    url.searchParams.append('image', image);
    url.searchParams.append('tag', tag);
    url = url.toString();

    // Filename's extension is what the backend persists the label under
    // (datastore/local.py's save_label keeps the uploaded filename's
    // extension) - 'label.nrrd' so it's stored as a real NRRD file the
    // backend's own training/active-learning pipeline can read, not an
    // opaque '.bin' blob.
    const data = MonaiLabelClient.constructFormDataFromArray(
      params,
      label,
      'label',
      'label.nrrd'
    );

    return await MonaiLabelClient.api_put_data(url, data, 'json');
  }

  // The backend's label datastore keys a saved label by the image's own id
  // (label_id == image_id always - see datastore/local.py's save_label), so
  // fetching it back means asking for "the label of this image", not a
  // separately-tracked label id. Returns the raw NRRD bytes (arraybuffer),
  // same shape as infer()'s response, so it can go through the same
  // SegmentationReader.parseNrrdData() path. A 404 (nothing saved for this
  // image/tag yet) comes back as a normal non-200 response, not a thrown
  // error - callers should treat that as "no saved label", not a failure.
  async get_label(image, tag = 'final') {
    let url = new URL('datastore/label', this.server_url);
    url.searchParams.append('label', image);
    url.searchParams.append('tag', tag);
    url = url.toString();

    return await MonaiLabelClient.api_get_data(url, 'arraybuffer');
  }

  // label_id == image_id (see save_label's comment above), so deleting a
  // saved segmentation means asking the backend to remove "the label of
  // this image" for the given tag - which, for a DICOMWeb-backed
  // datastore, also deletes the actual DICOM SEG series it uploaded to
  // the PACS (not just a local cache entry).
  async remove_label(image, tag = 'final') {
    let url = new URL('datastore/label', this.server_url);
    url.searchParams.append('id', image);
    url.searchParams.append('tag', tag);
    url = url.toString();

    return await MonaiLabelClient.api_delete(url);
  }

  // Lists every saved label (tag) for this image with its info dict
  // ({model, classes, ts, ...} - whatever save_label's params contained),
  // for the "Load Segmentation" picker. Manual saves use a distinct
  // 'save-<timestamp>' tag per save (see MonaiLabelPanel.onSaveSegmentation)
  // rather than always overwriting a single 'final' tag, so there can be
  // many to choose from.
  async list_labels(image) {
    let url = new URL('datastore/label/list', this.server_url);
    url.searchParams.append('image', image);
    url = url.toString();

    return await MonaiLabelClient.api_get_data(url, 'json');
  }

  // Combines the latest saved lung + ILD-class segmentations for this
  // image into 12-region (side x zone x depth) volumetric statistics -
  // see radiology/lib/regional_stats.py. A 422 response means one of the
  // two required saves (nnunet_lung, nnunet_ild/sam2_ild) doesn't exist
  // yet for this image; that's a normal response to check for, not a
  // thrown error.
  async regional_stats(image, peripheralDistanceMm) {
    let url = new URL('datastore/label/regional_stats', this.server_url);
    url.searchParams.append('image', image);
    if (peripheralDistanceMm) {
      url.searchParams.append('peripheral_distance_mm', peripheralDistanceMm);
    }
    url = url.toString();

    return await MonaiLabelClient.api_get_data(url, 'json');
  }

  async is_train_running() {
    let url = new URL('train/', this.server_url);
    url.searchParams.append('check_if_running', 'true');
    url = url.toString();

    const response = await MonaiLabelClient.api_get(url);
    return (
      response && response.status === 200 && response.data.status === 'RUNNING'
    );
  }

  async run_train(params) {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_post(url, params, null, false, 'json');
  }

  async stop_train() {
    const url = new URL('train/', this.server_url).toString();
    return await MonaiLabelClient.api_delete(url);
  }

  static constructFormDataFromArray(params, data, name, fileName) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));
    formData.append(name, data, fileName);
    return formData;
  }

  static constructFormData(params, files) {
    let formData = new FormData();
    formData.append('params', JSON.stringify(params));

    if (files) {
      if (!Array.isArray(files)) {
        files = [files];
      }
      for (let i = 0; i < files.length; i++) {
        formData.append(files[i].name, files[i].data, files[i].fileName);
      }
    }
    return formData;
  }

  static constructFormOrJsonData(params, files) {
    return files ? MonaiLabelClient.constructFormData(params, files) : params;
  }

  static api_get(url) {
    console.debug('GET:: ' + url);
    return axios
      .get(url)
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }

  static api_get_data(url, responseType = 'json') {
    console.debug('GET:: ' + url);
    return axios
      .get(url, { responseType })
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }

  static api_delete(url) {
    console.debug('DELETE:: ' + url);
    return axios
      .delete(url)
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }

  static api_post(
    url,
    params,
    files,
    form = true,
    responseType = 'arraybuffer'
  ) {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_post_data(url, data, responseType);
  }

  static api_post_data(url, data, responseType) {
    console.debug('POST:: ' + url);
    return axios
      .post(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }

  static api_put(url, params, files, form = false, responseType = 'json') {
    const data = form
      ? MonaiLabelClient.constructFormData(params, files)
      : MonaiLabelClient.constructFormOrJsonData(params, files);
    return MonaiLabelClient.api_put_data(url, data, responseType);
  }

  static api_put_data(url, data, responseType = 'json') {
    console.debug('PUT:: ' + url);
    return axios
      .put(url, data, {
        responseType: responseType,
        headers: {
          accept: ['application/json', 'multipart/form-data'],
        },
      })
      .then(function (response) {
        console.debug(response);
        return response;
      })
      .catch(function (error) {
        return error;
      });
  }
}
