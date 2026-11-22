import test from 'node:test';
import assert from 'node:assert/strict';
import {enhanceDocumentPixels, enhanceDocumentFrame} from '../dist/document-filter.js';

function pixels(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    data.set(typeof color === 'function' ? color(x, y) : color, (y * width + x) * 4);
  return data;
}
const rgba = (data, width, x, y) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
const light = color => (54 * color[0] + 183 * color[1] + 19 * color[2]) / 256;

function canvasFactory({error, context = true} = {}) {
  const created = [];
  function createCanvas() {
    const canvas = {width: 0, height: 0, image: null, options: null};
    canvas.getContext = (kind, options) => {
      assert.equal(kind, '2d');canvas.options = options;
      if (!context) return null;
      return {
        drawImage(frame, x, y, width, height) {
          assert.equal(x, 0);assert.equal(y, 0);assert.equal(width, frame.width);assert.equal(height, frame.height);
          canvas.image = new Uint8ClampedArray(frame.data);
        },
        getImageData(x, y, width, height) {
          if (error) throw error;
          assert.equal(width * height * 4, canvas.image.length);
          return {width, height, data: new Uint8ClampedArray(canvas.image)};
        },
        putImageData(image, x, y) {assert.equal(x, 0);assert.equal(y, 0);canvas.image = image.data;}
      };
    };
    created.push(canvas);return canvas;
  }
  return {created, createCanvas};
}

test('scan enhancement whitens paper and deepens ink without modifying original pixels', () => {
  const width = 240, height = 160;
  const input = pixels(width, height, (x, y) => y >= 70 && y < 85 ? [30, 30, 30, 255] : [216, 216, 216, 255]);
  const before = input.slice(), output = enhanceDocumentPixels(input, width, height);
  assert.notEqual(output, input);assert.deepEqual(input, before);
  const paper = rgba(output, width, 120, 20)[0], ink = rgba(output, width, 120, 75)[0];
  assert.ok(paper >= 248, `paper ${paper}`);assert.ok(ink <= 20, `ink ${ink}`);
  assert.ok(paper - ink > 216 - 30);
});

test('smooth illumination correction makes shadowed paper more even while keeping dark ink and faint pencil', () => {
  const width = 640, height = 360;
  const input = pixels(width, height, (x, y) => {
    let gray = 100 + 130 * x / (width - 1);
    if (y >= 120 && y < 134) gray *= .1;
    if (y >= 230 && y < 244) gray *= .78;
    return [gray, gray, gray, 255];
  });
  const output = enhanceDocumentPixels(input, width, height);
  const originalPapers = [], papers = [];
  for (const x of [0, 50, 160, 320, 480, 639]) {
    const before = rgba(input, width, x, 20)[0], after = rgba(output, width, x, 20)[0];
    originalPapers.push(before);papers.push(after);
    assert.ok(after > before, `paper at ${x} should brighten`);
    assert.ok(rgba(output, width, x, 125)[0] <= rgba(input, width, x, 125)[0]);
    const beforePencil = rgba(input, width, x, 235)[0], afterPencil = rgba(output, width, x, 235)[0];
    assert.ok(after - afterPencil > before - beforePencil, `pencil contrast at ${x}`);
    assert.ok(afterPencil > 80, 'light pencil stays a continuous tone rather than binary black');
  }
  assert.ok(Math.max(...papers) - Math.min(...papers) < (Math.max(...originalPapers) - Math.min(...originalPapers)) * .6);
  // Tile interpolation must not create visible 48-pixel brightness seams.
  for (let x = 1; x < width; x++)
    assert.ok(Math.abs(rgba(output, width, x, 20)[0] - rgba(output, width, x - 1, 20)[0]) <= 5);
});

test('colored illustrations retain hue and continuous tone rather than becoming a monochrome threshold', () => {
  const width = 240, height = 180;
  const samples = [[180, 38, 35, 255], [35, 85, 180, 255], [55, 145, 70, 255], [170, 120, 45, 255]];
  const input = pixels(width, height, (x, y) => y >= 60 && y < 84 ? samples[Math.floor(x / 60)] : [220, 220, 220, 255]);
  const output = enhanceDocumentPixels(input, width, height);
  for (let index = 0; index < samples.length; index++) {
    const color = rgba(output, width, index * 60 + 30, 70), before = samples[index];
    assert.ok(Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3)) > 70);
    assert.equal(color.indexOf(Math.max(...color.slice(0, 3))), before.indexOf(Math.max(...before.slice(0, 3))));
    assert.ok(color.slice(0, 3).every(channel => channel > 0 && channel < 255));
    const firstRatio = color[0] / color[1], oldRatio = before[0] / before[1];
    assert.ok(Math.abs(firstRatio - oldRatio) < .1, 'hue ratios remain close');
  }
});

test('transparent edges keep their original alpha and transparent RGB; partial alpha is not turned opaque', () => {
  const width = 96, height = 72;
  const input = pixels(width, height, (x, y) => x < 3 ? [90, 27, 190, 0]
    : x < 6 ? [110, 110, 110, 128] : [210, 210, 210, 255]);
  const output = enhanceDocumentPixels(input, width, height);
  for (let pixel = 0; pixel < input.length; pixel += 4) {
    assert.equal(output[pixel + 3], input[pixel + 3]);
    if (!input[pixel + 3]) assert.deepEqual([...output.slice(pixel, pixel + 4)], [...input.slice(pixel, pixel + 4)]);
  }
});

test('almost-black, empty-alpha, saturated-only, and single-pixel frames remain safe and bounded', () => {
  for (const color of [[0, 0, 0, 255], [10, 10, 10, 255], [73, 24, 198, 0], [255, 0, 0, 255]]) {
    const input = pixels(12, 10, color), output = enhanceDocumentPixels(input, 12, 10);
    assert.deepEqual(output, input);
  }
  for (const color of [[255, 255, 255, 255], [200, 200, 200, 255], [0, 0, 0, 0]]) {
    const output = enhanceDocumentPixels(new Uint8ClampedArray(color), 1, 1);
    assert.equal(output.length, 4);assert.equal(output[3], color[3]);assert.ok(light(output) >= light(color));
  }
});

test('invalid dimensions and pixel buffers fail before allocating unbounded work', () => {
  for (const [width, height] of [[0, 2], [-1, 2], [1.5, 4], [NaN, 4], [Infinity, 2], [4001, 4000], [32769, 1]])
    assert.throws(() => enhanceDocumentPixels(new Uint8ClampedArray(4), width, height), /decoded image/);
  for (const data of [null, [0, 0, 0, 255], new Float32Array(4), new Uint8ClampedArray(5)])
    assert.throws(() => enhanceDocumentPixels(data, 1, 1), /RGBA byte/);
});

test('frame enhancement returns a separate same-size canvas and reads only the copied source', () => {
  const h = canvasFactory(), frame = {width: 96, height: 72, data: pixels(96, 72, [210, 210, 210, 255])};
  const original = frame.data.slice(), result = enhanceDocumentFrame(frame, h);
  assert.equal(result, h.created[0]);assert.notEqual(result, frame);
  assert.equal(result.width, frame.width);assert.equal(result.height, frame.height);
  assert.deepEqual(frame.data, original);assert.ok(result.image[0] > frame.data[0]);
  assert.deepEqual(result.options, {willReadFrequently: true});
  assert.throws(() => enhanceDocumentFrame(frame, {createCanvas: () => frame}), /separate output/);
  assert.equal(frame.width, 96);assert.equal(frame.height, 72);
});

test('readback and context failures propagate, releasing only the new output canvas', () => {
  const frame = {width: 20, height: 20, data: pixels(20, 20, [210, 210, 210, 255])};
  const error = new DOMException('The source is tainted.', 'SecurityError');
  for (const h of [canvasFactory({error}), canvasFactory({context: false})]) {
    assert.throws(() => enhanceDocumentFrame(frame, h), error => error.name === 'SecurityError' || /2D canvas/.test(error.message));
    assert.equal(h.created[0].width, 0);assert.equal(h.created[0].height, 0);
    assert.equal(frame.width, 20);assert.equal(frame.height, 20);
  }
  assert.throws(() => enhanceDocumentFrame({width: 100000, height: 100000}, {createCanvas: () => assert.fail('must validate before allocating')}), /decoded image/);
});

test('full-resolution enhancement has bounded linear work and no growing cross-frame cache', () => {
  const width = 1600, height = 1200;
  const input = pixels(width, height, (x, y) => [y % 80 < 6 ? 35 : 215, y % 80 < 6 ? 35 : 215, y % 80 < 6 ? 35 : 215, 255]);
  const start = performance.now();
  for (let run = 0; run < 2; run++) {
    const output = enhanceDocumentPixels(input, width, height);
    assert.equal(output.byteLength, width * height * 4);
    assert.ok(output[0] < input[0]);assert.ok(output[width * 40 * 4] > input[width * 40 * 4]);
  }
  // A loose runaway guard, not a promised device FPS or machine benchmark.
  assert.ok(performance.now() - start < 2500, 'tile processing must not become a per-pixel neighborhood scan');
});
