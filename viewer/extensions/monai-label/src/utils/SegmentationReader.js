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

import nrrd from 'nrrd-js';
import pako from 'pako';

export default class SegmentationReader {
  static parseNrrdData(data) {
    let nrrdfile = nrrd.parse(data);

    // Currently gzip is not supported in nrrd.js
    if (nrrdfile.encoding === 'gzip') {
      const buffer = pako.inflate(nrrdfile.buffer).buffer;

      nrrdfile.encoding = 'raw';
      // uint8, not uint16: every writer in this app (see lib/infers/nnunet.py's
      // comment) emits uint8 label data, and `.data` here is discarded right
      // below anyway (`image` comes from `.buffer`, and `.data` is deleted) -
      // but Uint16Array still runs its "byteLength must be even" check just to
      // construct a value nothing uses, which throws for any odd total voxel
      // count. Preprocessed (cropped) volumes can have odd width/height where
      // the original DICOM series (always 512x512xN) never did, so this only
      // started firing once cropping existed. Uint8Array has no such
      // alignment requirement and matches the actual data width.
      nrrdfile.data = new Uint8Array(buffer);
      nrrdfile.buffer = buffer;
    }

    const image = nrrdfile.buffer;
    const header = nrrdfile;
    delete header.data;
    delete header.buffer;

    return {
      header,
      image,
    };
  }
}
