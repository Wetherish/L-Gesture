import test from 'node:test';
import assert from 'node:assert/strict';
import {refineDocumentQuad, refineDocumentSelection} from '../dist/document-corners.js';
import {perspectiveOutputGeometry, projectPerspective} from '../dist/perspective-crop.js';

const W = 360, H = 280;
const PAGE = [{x: 83, y: 46}, {x: 285, y: 63}, {x: 305, y: 238}, {x: 50, y: 224}];
const rectangle = (left, top, right, bottom) => [
  {x: left, y: top}, {x: right, y: top}, {x: right, y: bottom}, {x: left, y: bottom},
];
const normalize = (points, width = W, height = H) => points.map(({x, y}) => ({x: x / (width - 1), y: y / (height - 1)}));
const shifted = points => points.map((point, i) => ({x: point.x + [-3, 4, 3, -4][i], y: point.y + [-4, -3, 4, 3][i]}));
const pixelDistance = (a, b, width = W, height = H) => Math.hypot(a.x * (width - 1) - b.x, a.y * (height - 1) - b.y);
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

function fixture({corners = PAGE, width = W, height = H, background = 45, paper = 230, alpha = 255} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = corners && corners.every((a, index) => {
      const b = corners[(index + 1) % 4];
      return (b.x - a.x) * (y + .5 - a.y) - (b.y - a.y) * (x + .5 - a.x) >= 0;
    });
    const index = (y * width + x) * 4, value = inside ? paper : background;
    data[index] = data[index + 1] = data[index + 2] = value;data[index + 3] = alpha;
  }
  return {data, width, height};
}

function paint(image, left, top, right, bottom, value, alpha = 255) {
  for (let y = Math.max(0, Math.floor(top)); y < Math.min(image.height, Math.ceil(bottom)); y++)
    for (let x = Math.max(0, Math.floor(left)); x < Math.min(image.width, Math.ceil(right)); x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;image.data[i + 3] = alpha;
    }
}

function selection(quad = normalize(shifted(PAGE)), extra = {}) {
  return {status: 'ready', documentKind: 'notebook', label: 'Synthetic notebook', width: W, height: H,
    crop: {x: .1, y: .1, width: .8, height: .8}, quad, transform: {type: 'perspective', quad},
    orientation: {status: 'text-upright', method: 'page-corners', clockwiseDegrees: 180}, ...extra};
}

function canvasFactory(image, {missingContext = false, missingReadback = false, readError = false} = {}) {
  const canvases = [], calls = [];
  function createCanvas() {
    const canvas = {width: 0, height: 0};
    canvas.getContext = (kind, options) => {
      calls.push({type: 'context', kind, options});
      if (missingContext) return null;
      return {drawImage(...args) {calls.push({type: 'draw', args});},
        ...(missingReadback ? {} : {getImageData(...args) {
          calls.push({type: 'read', args});if (readError) throw new Error('Readback unavailable');return image;
        }})};
    };
    canvases.push(canvas);return canvas;
  }
  return {createCanvas, canvases, calls};
}

test('four edge-supported trapezoid corners improve slightly offset model geometry with either contrast polarity', () => {
  for (const [background, paper] of [[45, 230], [230, 35], [100, 125]]) {
    const image = fixture({background, paper}), model = normalize(shifted(PAGE));
    const before = structuredClone(model), pixels = new Uint8ClampedArray(image.data);
    const result = refineDocumentQuad(image, model);
    assert.equal(result.verifiedEdges, 4);assert.equal(result.quad.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.ok(pixelDistance(result.quad[i], PAGE[i]) < 2.3, 'edge fit must stay close to the true paper corner');
      assert.ok(pixelDistance(result.quad[i], PAGE[i]) < pixelDistance(model[i], PAGE[i]), 'refinement must improve the model estimate');
    }
    assert.deepEqual(model, before);assert.deepEqual(image.data, pixels);
  }
});

test('cyclic reading order survives local edge fitting and maps to rectified output without a mirror or second rotation', () => {
  const image = fixture();
  for (let start = 0; start < 4; start++) {
    const original = normalize(shifted(PAGE));
    const quad = [...original.slice(start), ...original.slice(0, start)];
    const result = refineDocumentQuad(image, quad);
    assert.equal(result.verifiedEdges, 4);assert.ok(result.quad);
    for (let i = 0; i < 4; i++) assert.ok(pixelDistance(result.quad[i], PAGE[(i + start) % 4]) < 2.3);
    const geometry = perspectiveOutputGeometry({type: 'perspective', quad: result.quad}, W, H);
    for (const [index, [x, y]] of [[0, [0, 0]], [1, [1, 0]], [2, [1, 1]], [3, [0, 1]]]) {
      const point = projectPerspective(geometry.matrix, x, y);
      near(point.x, result.quad[index].x);near(point.y, result.quad[index].y);
    }
  }
});

test('uniform, very low contrast and fully transparent pixels cannot verify nonexistent paper boundaries', () => {
  for (const image of [fixture({background: 220, paper: 220}), fixture({background: 220, paper: 225}),
    fixture({background: 0, paper: 255, alpha: 0})]) {
    assert.deepEqual(refineDocumentQuad(image, normalize(shifted(PAGE))), {quad: null, verifiedEdges: 0});
  }
});

test('three clear edges do not invent an unseen fourth page edge', () => {
  const corners = rectangle(70, 50, 290, 220);
  // The visible sheet continues beyond the image. Its supposed bottom edge
  // at y=220 has no image evidence, despite three other unambiguous sides.
  const image = fixture({corners: rectangle(70, 50, 290, H + 20)});
  const result = refineDocumentQuad(image, normalize(corners));
  assert.equal(result.verifiedEdges, 3);assert.equal(result.quad, null);
});

test('small isolated writing and a short occlusion do not pull the outer-page fit into the content', () => {
  const page = rectangle(70, 50, 290, 230), image = fixture({corners: page});
  for (let row = 0; row < 9; row++) for (let word = 0; word < 4; word++)
    paint(image, 92 + word * 42, 75 + row * 14, 117 + word * 42, 78 + row * 14, 25);
  // One obstruction hides less than a fifth of the right boundary.
  paint(image, 279, 122, 310, 143, 115);
  const result = refineDocumentQuad(image, normalize(shifted(page)));
  assert.equal(result.verifiedEdges, 4);assert.ok(result.quad);
  for (let i = 0; i < 4; i++) assert.ok(pixelDistance(result.quad[i], page[i]) < 2.5);
});

test('a long occlusion or text-like clutter without page boundaries preserves the model rather than making up four corners', () => {
  const page = rectangle(70, 50, 290, 230), occluded = fixture({corners: page});
  paint(occluded, 270, 80, 320, 202, 115);
  const clutter = fixture({corners: null, background: 230});
  for (let row = 0; row < 14; row++) for (let word = 0; word < 7; word++)
    paint(clutter, 58 + word * 35, 48 + row * 14, 80 + word * 35, 51 + row * 14, 35);
  for (const image of [occluded, clutter]) {
    const result = refineDocumentQuad(image, normalize(page));
    assert.equal(result.quad, null);assert.ok(result.verifiedEdges < 4);
  }
});

test('distant boundaries outside the narrow model-guided search are not substituted as a new object', () => {
  const result = refineDocumentQuad(fixture({corners: rectangle(45, 25, 320, 255)}),
    normalize(rectangle(80, 60, 280, 220)));
  assert.equal(result.quad, null);assert.equal(result.verifiedEdges, 0);
});

test('tiny surfaces and invalid pixel buffers never produce unchecked corner corrections', () => {
  assert.deepEqual(refineDocumentQuad(fixture(), normalize(rectangle(100, 100, 120, 120))), {quad: null, verifiedEdges: 0});
  for (const image of [{width: 0, height: 20, data: []}, {width: 7, height: 20, data: new Uint8ClampedArray(560)},
    {width: 960, height: 961, data: []}, {width: 20, height: 20, data: new Uint8ClampedArray(1599)}])
    assert.throws(() => refineDocumentQuad(image, normalize(PAGE)), RangeError);
});

test('selection refinement keeps raw-frame ownership and unrelated model metadata while tightening only crop geometry', () => {
  const image = fixture(), h = canvasFactory(image), frame = {width: W, height: H};
  const input = selection(), before = structuredClone(input);
  const result = refineDocumentSelection(frame, input, h);
  assert.deepEqual(input, before);assert.deepEqual(frame, {width: W, height: H});
  assert.equal(result.documentKind, 'notebook');assert.deepEqual(result.orientation, before.orientation);
  assert.deepEqual(result.cornerRefinement, {method: 'edge-refined', verifiedEdges: 4});
  assert.notEqual(result, input);assert.notEqual(result.transform, input.transform);
  assert.equal(result.transform.quad, result.quad);assert.equal(result.transform.rotationDegrees, undefined);
  for (const point of result.quad) {
    assert.ok(point.x >= result.crop.x - 1e-9 && point.x <= result.crop.x + result.crop.width + 1e-9);
    assert.ok(point.y >= result.crop.y - 1e-9 && point.y <= result.crop.y + result.crop.height + 1e-9);
  }
  assert.deepEqual(h.calls.find(call => call.type === 'draw').args, [frame, 0, 0, W, H]);
  assert.equal(h.canvases[0].width, 0);assert.equal(h.canvases[0].height, 0);
});

test('four real document edges still refine before the mandatory software 180-degree turn', () => {
  const image = fixture(), h = canvasFactory(image), originalQuad = normalize(shifted(PAGE));
  const input = selection(originalQuad, {transform: {type: 'perspective', quad: originalQuad, rotationDegrees: 180},
    orientation: {status: 'software-rotated', method: 'page-corners-plus-180', clockwiseDegrees: 180}});
  const before = structuredClone(input), result = refineDocumentSelection({width: W, height: H}, input, h);
  assert.deepEqual(input, before);assert.deepEqual(result.cornerRefinement, {method: 'edge-refined', verifiedEdges: 4});
  assert.equal(result.transform.rotationDegrees, 180);assert.deepEqual(result.orientation, before.orientation);
  assert.notDeepEqual(result.quad, originalQuad);
  const geometry = perspectiveOutputGeometry(result.transform, W, H);
  for (const [index, [x, y]] of [[2, [0, 0]], [3, [1, 0]], [0, [1, 1]], [1, [0, 1]]]) {
    const source = projectPerspective(geometry.matrix, x, y);
    near(source.x, result.quad[index].x);near(source.y, result.quad[index].y);
  }
});

test('ambiguous or inaccessible Canvas readback retains original model corners with honest evidence metadata', () => {
  for (const options of [{missingContext: true}, {missingReadback: true}, {readError: true}, {}]) {
    const h = canvasFactory(fixture({background: 220, paper: 220}), options), input = selection(), before = structuredClone(input);
    const result = refineDocumentSelection({width: W, height: H}, input, h);
    assert.deepEqual(result.cornerRefinement, {method: 'model-corners', verifiedEdges: 0});
    assert.equal(result.transform, input.transform);assert.equal(result.quad, input.quad);assert.equal(result.crop, input.crop);
    assert.deepEqual(input, before);assert.equal(h.canvases[0].width, 0);assert.equal(h.canvases[0].height, 0);
  }
  const input = selection();
  const result = refineDocumentSelection({width: W, height: H}, input, {createCanvas() {throw new Error('Canvas unavailable');}});
  assert.deepEqual(result.transform, input.transform);assert.equal(result.cornerRefinement.method, 'model-corners');
});

test('wrapper records three-sided evidence but keeps all original model corners instead of partially replacing them', () => {
  const page = rectangle(70, 50, 290, 220), h = canvasFactory(fixture({corners: rectangle(70, 50, 290, H + 20)}));
  const input = selection(normalize(page)), result = refineDocumentSelection({width: W, height: H}, input, h);
  assert.deepEqual(result.cornerRefinement, {method: 'model-corners', verifiedEdges: 3});
  assert.equal(result.quad, input.quad);assert.equal(result.transform, input.transform);assert.equal(result.crop, input.crop);
});

test('non-documents, missing corner geometry and explicit rectangle rotations never invoke edge refinement', () => {
  const h = canvasFactory(fixture());
  for (const result of [null, {status: 'not-found'}, selection(undefined, {documentKind: undefined}),
    selection(undefined, {documentKind: 'phone'}), selection(undefined, {transform: undefined}),
    selection(undefined, {transform: {type: 'perspective', quad: normalize(PAGE), rotationDegrees: 180}})])
    assert.equal(refineDocumentSelection({width: W, height: H}, result, h), result);
  assert.equal(h.canvases.length, 0);
});

test('large landscape and portrait frames are read once at bounded dimensions with original normalized coordinates', () => {
  for (const [width, height, expectedWidth, expectedHeight] of [[3840, 2160, 960, 540], [2160, 3840, 540, 960]]) {
    const image = fixture({width: expectedWidth, height: expectedHeight, corners: null, background: 220});
    const h = canvasFactory(image), frame = {width, height};
    const input = selection(), result = refineDocumentSelection(frame, input, h);
    assert.equal(result.transform, input.transform);
    assert.deepEqual(h.calls.filter(call => call.type === 'draw').map(call => call.args), [[frame, 0, 0, expectedWidth, expectedHeight]]);
    assert.deepEqual(h.calls.filter(call => call.type === 'read').map(call => call.args), [[0, 0, expectedWidth, expectedHeight]]);
    assert.equal(h.canvases[0].width, 0);assert.equal(h.canvases[0].height, 0);
  }
});
