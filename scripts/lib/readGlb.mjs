import { readFile } from 'node:fs/promises';

const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export async function readGlb(path) {
  const file = await readFile(path);
  if (file.toString('utf8', 0, 4) !== 'glTF') throw new Error(`${path} is not a GLB`);
  const length = file.readUInt32LE(8);
  if (length !== file.length) throw new Error(`GLB length mismatch: header=${length}, file=${file.length}`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= file.length) {
    const chunkLength = file.readUInt32LE(offset);
    const chunkType = file.readUInt32LE(offset + 4);
    const data = file.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(data.toString('utf8').replace(/\0+$/g, '').trim());
    if (chunkType === 0x004e4942) bin = data;
    offset += 8 + chunkLength;
  }
  if (!json || !bin) throw new Error('GLB must contain JSON and BIN chunks');
  return { json, bin };
}

export function readAccessor(glb, accessorIndex) {
  const accessor = glb.json.accessors[accessorIndex];
  const view = glb.json.bufferViews[accessor.bufferView];
  if (!accessor || !view) throw new Error(`Missing accessor ${accessorIndex}`);
  if (accessor.sparse) throw new Error(`Sparse accessor ${accessorIndex} is unsupported`);
  const ArrayType = COMPONENT_ARRAYS[accessor.componentType];
  const itemSize = TYPE_SIZE[accessor.type];
  if (!ArrayType || !itemSize) throw new Error(`Unsupported accessor ${accessorIndex}`);
  const componentBytes = ArrayType.BYTES_PER_ELEMENT;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const packedStride = itemSize * componentBytes;
  const stride = view.byteStride ?? packedStride;
  const output = new Array(accessor.count * itemSize);
  const data = glb.bin;
  const reader = componentReader(accessor.componentType);
  for (let index = 0; index < accessor.count; index += 1) {
    const base = byteOffset + index * stride;
    for (let component = 0; component < itemSize; component += 1) {
      output[index * itemSize + component] = reader(data, base + component * componentBytes);
    }
  }
  return { values: output, itemSize, count: accessor.count, accessor };
}

function componentReader(componentType) {
  switch (componentType) {
    case 5120: return (buffer, offset) => buffer.readInt8(offset);
    case 5121: return (buffer, offset) => buffer.readUInt8(offset);
    case 5122: return (buffer, offset) => buffer.readInt16LE(offset);
    case 5123: return (buffer, offset) => buffer.readUInt16LE(offset);
    case 5125: return (buffer, offset) => buffer.readUInt32LE(offset);
    case 5126: return (buffer, offset) => buffer.readFloatLE(offset);
    default: throw new Error(`Unsupported component type ${componentType}`);
  }
}

