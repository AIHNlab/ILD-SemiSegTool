// The light run-length form labelmaps travel in between viewer and server,
// both ways, so saving and showing AI results stay quick on any browser -
// tablets and phones included. AI results come back in it too (decodeLabelmap).
//
// Uploads: The browser only run-length encodes
// the labelmap (one plain loop, no libraries); the server finds the classes
// present, compresses and writes the stored .nrrd (backend/lib/label_upload.py,
// which documents the format):
//   "ILDRLE01" | uint32 n | n x uint32 run lengths | n x uint8 values  (little-endian)
// A CT labelmap is mostly long runs of one value, so this is typically a few
// hundred KB to a few MB instead of ~80 MB of raw voxels.

const MAGIC = 'ILDRLE01';

// -> { parts: Blob parts of the upload, seen: Uint8Array(256), seen[v] = 1 for every value present }
export function encodeLabelmap(data) {
  const n = data.length;
  let cap = 1 << 16;
  let lengths = new Uint32Array(cap);
  let values = new Uint8Array(cap);
  const seen = new Uint8Array(256);
  let runs = 0;
  let current = n ? data[0] : 0;
  let length = 0;

  const push = () => {
    if (runs === cap) {
      cap *= 2;
      const l = new Uint32Array(cap);
      l.set(lengths);
      lengths = l;
      const v = new Uint8Array(cap);
      v.set(values);
      values = v;
    }
    lengths[runs] = length;
    values[runs] = current;
    seen[current & 255] = 1;
    runs++;
  };

  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v === current) {
      length++;
    } else {
      push();
      current = v;
      length = 1;
    }
  }
  if (length) {
    push();
  }

  const header = new Uint8Array(12);
  for (let i = 0; i < MAGIC.length; i++) {
    header[i] = MAGIC.charCodeAt(i);
  }
  new DataView(header.buffer).setUint32(8, runs, true);
  // Typed arrays use the machine's byte order - little-endian on every
  // platform a browser runs on (x86, ARM phones and tablets).
  return { parts: [header, lengths.subarray(0, runs), values.subarray(0, runs)], seen };
}

// gzip with the browser's own built-in compressor when it has one (no
// library; Safari 16.4+, Chrome 80+, Firefox 113+). Older browsers just send
// the run-length data as it is - the server accepts both.
export async function compressIfSupported(blob) {
  if (typeof CompressionStream === 'undefined' || typeof blob.stream !== 'function') {
    return blob;
  }
  try {
    return await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  } catch (e) {
    console.warn('Browser gzip failed - uploading uncompressed', e);
    return blob;
  }
}

// True if an ArrayBuffer is in this format (an AI result asked for with
// result_format 'rle'), not an NRRD.
export function isRle(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  return head.length === 8 && String.fromCharCode(...head) === MAGIC;
}

// Rebuilds a labelmap of `total` voxels, mapping every value v to lut[v]
// (the model's class numbers -> this session's segment indices) as it goes:
// one native block fill per run instead of decompressing and remapping
// ~80 million voxels one by one in JavaScript.
// -> { data: Uint8Array(total), present: Uint8Array(256), present[v] = 1 for every value written }
export function decodeLabelmap(buffer, total, lut) {
  const view = new DataView(buffer);
  const runs = view.getUint32(8, true);
  if (buffer.byteLength !== 12 + 5 * runs) {
    throw new Error('Truncated run-length labelmap');
  }
  // Copied out, as the run lengths needn't be 4-byte aligned in a larger buffer.
  const lengths = new Uint32Array(buffer.slice(12, 12 + 4 * runs));
  const values = new Uint8Array(buffer, 12 + 4 * runs, runs);
  const data = new Uint8Array(total);
  const present = new Uint8Array(256);
  let pos = 0;
  for (let r = 0; r < runs; r++) {
    const v = lut[values[r]];
    const end = pos + lengths[r];
    if (v) {
      data.fill(v, pos, end);
    }
    present[v] = 1;
    pos = end;
  }
  if (pos !== total) {
    throw new Error(`Labelmap has ${pos} voxels, the image has ${total}`);
  }
  return { data, present };
}

// The encoded labelmap as one ArrayBuffer (decodeLabelmap's input) - a compact
// copy of a whole volume, e.g. for undoing a whole AI result.
export function encodeLabelmapBuffer(data) {
  const { parts } = encodeLabelmap(data);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), pos);
    pos += p.byteLength;
  }
  return out.buffer;
}

export const IDENTITY_LUT = Uint8Array.from({ length: 256 }, (_, i) => i);
