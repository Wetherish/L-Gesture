import test from 'node:test';
import assert from 'node:assert/strict';
import {gazeSearchRegion,gazePointInRegion,selectGazeMask,normalizeGazeContrast} from '../dist/gaze-region.js';

const scene={width:800,height:600},full={x:0,y:0,width:1,height:1};
function mask(width=80,height=60,rect={x:.3,y:.3,width:.4,height:.4},probability=.9){
  const data=new Float32Array(width*height);
  if(rect)for(let y=Math.floor(rect.y*height);y<Math.ceil((rect.y+rect.height)*height-1e-9);y++)for(let x=Math.floor(rect.x*width);x<Math.ceil((rect.x+rect.width)*width-1e-9);x++)data[y*width+x]=probability;
  return {width,height,data};
}
const selection=(value,options={})=>selectGazeMask({mask:value,point:{x:.5,y:.5},region:full,scene},options);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} should equal ${expected}`);
function tightContainment(crop,box){
  assert.ok(crop.x<=box.x&&crop.y<=box.y);
  assert.ok(crop.x+crop.width>=box.x+box.width-1e-12&&crop.y+crop.height>=box.y+box.height-1e-12);
  assert.ok(box.x-crop.x<=box.width*.02+1e-12&&box.y-crop.y<=box.height*.02+1e-12);
  assert.ok(crop.x+crop.width-box.x-box.width<=box.width*.02+1e-12);
  assert.ok(crop.y+crop.height-box.y-box.height<=box.height*.02+1e-12);
}

test('generous ROI keeps image aspect and contains the actual point while shifting at edges',()=>{
  for(const dimensions of [scene,{width:512,height:640},{width:1920,height:1080}])for(const point of [{x:.5,y:.5},{x:0,y:1},{x:.97,y:.04}]){
    const roi=gazeSearchRegion(point,dimensions),local=gazePointInRegion(point,roi);
    assert.equal(roi.width,.75);assert.equal(roi.height,.75);assert.ok(local.x>=0&&local.x<=1&&local.y>=0&&local.y<=1);
    assert.equal(roi.width*dimensions.width/(roi.height*dimensions.height),dimensions.width/dimensions.height);
  }
  assert.equal(gazePointInRegion({x:0,y:0},{x:.2,y:.2,width:.5,height:.5}),null);
  assert.throws(()=>gazeSearchRegion({x:-.1,y:.5},scene),RangeError);
});
test('real connected foreground yields a tight padded crop without inventing a category or model confidence',()=>{
  const result=selection(mask());assert.equal(result.status,'ready');assert.equal(result.selection,'segment');assert.equal(result.score,null);
  assert.equal(result.label,'Segmented region');assert.ok(result.crop.x<.3&&result.crop.x>.28);
  assert.ok(result.crop.width>.4&&result.crop.width<.44);assert.ok(result.statistics.meanForegroundProbability>.89);
  assert.equal(result.statistics.componentPixels,32*24);
  tightContainment(result.crop,result.bbox);near(result.crop.x,.292);near(result.crop.y,.292);
  near(result.crop.width,.416);near(result.crop.height,.416);
});
test('the point component wins over a disconnected distant foreground patch',()=>{
  const value=mask(80,60,{x:.4,y:.4,width:.2,height:.2});
  for(let y=2;y<20;y++)for(let x=2;x<20;x++)value.data[y*80+x]=.99;
  const result=selection(value);assert.equal(result.status,'ready');assert.ok(result.bbox.x>=.4);assert.ok(result.bbox.width<=.21);
  assert.ok(result.statistics.foregroundPixels>result.statistics.componentPixels);
});
test('empty, remote, tiny, full-flood and invalid masks cannot produce guessed crops',()=>{
  assert.equal(selection(mask(80,60,null)).status,'empty-mask');
  assert.equal(selection(mask(80,60,{x:.05,y:.05,width:.1,height:.1})).status,'mask-missing-seed');
  assert.equal(selection(mask(80,60,{x:.5,y:.5,width:.012,height:.016})).status,'small-mask');
  assert.equal(selection(mask(80,60,full)).status,'flood-mask');
  const invalid=mask();invalid.data[0]=NaN;assert.equal(selection(invalid).status,'invalid-mask');
  assert.equal(selection({...mask(),height:59}).status,'invalid-mask');
  assert.equal(selection(null).status,'invalid-mask');
  assert.equal(selection(mask(80,80)).status,'invalid-mask','a different aspect ratio cannot be projected into the source');
});
test('foreground at an artificial search edge requests expansion; a real source edge remains usable',()=>{
  const roi={x:.125,y:.125,width:.75,height:.75},value=mask(80,60,{x:0,y:.3,width:.65,height:.4});
  const clipped=selectGazeMask({mask:value,point:{x:.5,y:.5},region:roi,scene});
  assert.equal(clipped.status,'truncated-mask');assert.deepEqual(clipped.statistics.artificialEdges,['left']);assert.equal(clipped.crop,null);
  const fullSize=selection(value);assert.equal(fullSize.status,'ready');assert.equal(fullSize.crop.x,0);
});
test('a completely filled ROI gets a boundary-rescue signal rather than being mistaken for a valid object',()=>{
  const result=selectGazeMask({mask:mask(80,60,full),point:{x:.5,y:.5},region:{x:.125,y:.125,width:.75,height:.75},scene});
  assert.equal(result.status,'truncated-mask');assert.equal(result.crop,null);assert.equal(result.statistics.artificialEdges.length,4);
});
test('mask bounds map through the exact ROI into source-normalized coordinates',()=>{
  const roi={x:.05,y:.2,width:.75,height:.75},value=mask();
  const result=selectGazeMask({mask:value,point:{x:.425,y:.575},region:roi,scene});
  assert.equal(result.status,'ready');assert.ok(Math.abs(result.bbox.x-(.05+.3*.75))<1e-12);
  assert.ok(Math.abs(result.bbox.y-(.2+.3*.75))<1e-12);assert.ok(Math.abs(result.bbox.width-.3)<1e-12);
  tightContainment(result.crop,result.bbox);near(result.crop.width,.312);near(result.crop.height,.312);
});
test('tight final mask borders retain complete visible objects at every real image edge',()=>{
  for(const [rect,point] of [[{x:0,y:.3,width:.6,height:.4},{x:.3,y:.5}],
    [{x:.4,y:.3,width:.6,height:.4},{x:.7,y:.5}],
    [{x:.3,y:0,width:.4,height:.6},{x:.5,y:.3}],
    [{x:.3,y:.4,width:.4,height:.6},{x:.5,y:.7}]]){
    const result=selectGazeMask({mask:mask(80,60,rect),point,region:full,scene});
    assert.equal(result.status,'ready');tightContainment(result.crop,result.bbox);
    assert.ok(result.crop.x>=0&&result.crop.y>=0&&result.crop.x+result.crop.width<=1&&result.crop.y+result.crop.height<=1);
  }
});
test('a small segmented object receives an object-relative border without a broad image-space minimum',()=>{
  const value=mask(400,300,{x:.49,y:.48,width:.02,height:.04}),result=selection(value);
  assert.equal(result.status,'ready');tightContainment(result.crop,result.bbox);
  near(result.crop.width,.0208);near(result.crop.height,.0416);
  assert.ok(result.crop.x>.489,'no fixed percentage of the whole image is added around a small object');
});
test('a downscaled mask remains valid for a 4K camera without allocating a 4K analysis image',()=>{
  const large={width:3840,height:2160},roi=gazeSearchRegion({x:.5,y:.5},large);
  const result=selectGazeMask({mask:mask(160,90),point:{x:.5,y:.5},region:roi,scene:large});
  assert.equal(result.status,'ready');assert.ok(result.crop.width<.34);assert.ok(result.crop.height<.34);
});

function canvasPixels(values,{width=10,height=10}={}){
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++){const pixel=values(i);data.set([...pixel,255],i*4);}
  const frame={width,height,getContext:()=>({getImageData:()=>({data})})};
  const outputs=[];
  const createCanvas=()=>{
    const canvas={width:0,height:0,data:null,getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{canvas.data=image.data;}})};
    outputs.push(canvas);return canvas;
  };
  return {frame,data,outputs,createCanvas};
}
test('low-contrast grayscale retries use deterministic real-pixel contrast without changing geometry or adding color',()=>{
  const h=canvasPixels(i=>{const value=100+i%20;return [value,value,value];}),original=h.data.slice();
  const result=normalizeGazeContrast(h.frame,{createCanvas:h.createCanvas});
  assert.equal(result.changed,true);assert.equal(result.canvas.width,10);assert.equal(result.canvas.height,10);assert.equal(result.statistics.grayscaleFraction,1);
  assert.deepEqual(h.data,original,'source pixels remain untouched');
  for(let i=0;i<result.canvas.data.length;i+=4){assert.equal(result.canvas.data[i],result.canvas.data[i+1]);assert.equal(result.canvas.data[i],result.canvas.data[i+2]);}
  assert.ok(Math.max(...result.canvas.data.filter((_,i)=>i%4===0))-Math.min(...result.canvas.data.filter((_,i)=>i%4===0))>100);
});
test('uniform and high-range grayscale images skip a redundant retry',()=>{
  for(const pixels of [()=>[111,111,111],i=>i%2?[250,250,250]:[0,0,0]]){
    const h=canvasPixels(pixels),result=normalizeGazeContrast(h.frame,{createCanvas:h.createCanvas});
    assert.equal(result.changed,false);assert.equal(result.canvas,null);assert.equal(h.outputs.length,0);
  }
});
test('color contrast preserves channel ordering and does not recolor an IR image',()=>{
  const h=canvasPixels(i=>[100+i%20,105+i%20,110+i%20]);
  const {canvas}=normalizeGazeContrast(h.frame,{createCanvas:h.createCanvas});
  for(let i=0;i<canvas.data.length;i+=4){assert.ok(canvas.data[i]<=canvas.data[i+1]);assert.ok(canvas.data[i+1]<=canvas.data[i+2]);}
});
