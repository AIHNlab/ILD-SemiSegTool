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

  // Counterpart to parseNrrdData - encodes a flat uint8 labelmap (in the
  // same voxel order cornerstone3D's own scalar data already uses) as a raw
  // NRRD file, for uploading to the backend's datastore.
  //
  // Hand-written instead of nrrd-js's own serialize(): that function has a
  // real bug for uint8/int8 data specifically - it correctly sets endian to
  // undefined for byte-sized types (endianness is meaningless there), but
  // its OWN buffer-selection logic then requires endian === the system's
  // endianness to take the direct-copy fast path; undefined never matches
  // that, so it falls through to serializeToBuffer(data, type, undefined),
  // whose endian switch has no `undefined` case and silently returns
  // undefined - serialize() then writes a header with NO data behind it at
  // all. That produced a file the backend's own NRRD reader (pynrrd,
  // stricter than nrrd-js's own parser) rejected with "size of the data
  // does not equal the product of all the dimensions: N-0=N". Raw-encoding
  // NRRD is simple enough that writing it directly avoids depending on that
  // fixed-in-neither-version-yet library path.
  //
  // `direction`/`spacing`/`origin` ARE needed (not optional): this backend's
  // datastore is DICOMWeb-backed, so saving a label always converts it to a
  // DICOM SEG server-side (monailabel.datastore.dicom.save_label ->
  // nifti_to_dicom_seg), which needs a real affine to know how the label
  // aligns with the source image - MONAI's NrrdReader raises a hard
  // KeyError('space directions') without one. `direction` is cornerstone3D/
  // vtk.js's own ImageData.direction: a flat 9-element array of THREE
  // per-axis UNIT vectors (direction[0:3] = index-axis-0's direction,
  // [3:6] = axis-1, [6:9] = axis-2 - confirmed from vtk.js's own
  // computeTransforms, which builds indexToWorld's 3 rotation columns from
  // exactly those slices before separately scaling by `spacing`). NRRD's
  // own "space directions" wants each axis's direction already scaled by
  // that axis's spacing, hence the multiplication below. Cornerstone3D
  // keeps DICOM's native LPS convention (it doesn't flip to RAS), so
  // `space: left-posterior-superior` is set explicitly rather than left
  // for MONAI to assume.
  static writeNrrdData(data, { sizes, direction, spacing, origin }) {
    const spaceDirections = [0, 1, 2]
      .map((axis) => {
        const v = [0, 1, 2].map(
          (c) => direction[axis * 3 + c] * spacing[axis]
        );
        return `(${v[0]},${v[1]},${v[2]})`;
      })
      .join(' ');
    const spaceOrigin = `(${origin[0]},${origin[1]},${origin[2]})`;

    const header =
      'NRRD0005\n' +
      'type: uint8\n' +
      `dimension: ${sizes.length}\n` +
      'space: left-posterior-superior\n' +
      `sizes: ${sizes.join(' ')}\n` +
      `space directions: ${spaceDirections}\n` +
      `space origin: ${spaceOrigin}\n` +
      'encoding: raw\n' +
      '\n';
    const headerBytes = new TextEncoder().encode(header);
    const buffer = new ArrayBuffer(headerBytes.length + data.byteLength);
    const bytes = new Uint8Array(buffer);
    bytes.set(headerBytes, 0);
    bytes.set(data, headerBytes.length);
    return buffer;
  }
}
