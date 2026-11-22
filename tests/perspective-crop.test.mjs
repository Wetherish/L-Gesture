import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReadingOrientation,orderImageQuad,normalizePerspectiveTransform,perspectiveMatrix,projectPerspective,perspectiveOutputGeometry,
  renderPerspectiveFrame,createPerspectiveCaptureSource} from '../dist/perspective-crop.js';

const rect={type:'perspective',quad:[{x:.2,y:.1},{x:.8,y:.1},{x:.8,y:.9},{x:.2,y:.9}]};
const trapezoid={type:'perspective',quad:[{x:.27,y:.15},{x:.71,y:.2},{x:.87,y:.84},{x:.11,y:.91}]};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} should equal ${b}`);
const full={x:0,y:0,width:1,height:1};

function canvasFactory(){
  const canvases=[];
  function createCanvas(){
    const canvas={width:1,height:1,operations:[]};
    const context={};
    for(const name of ['save','restore','beginPath','moveTo','lineTo','closePath','clip','setTransform','clearRect','drawImage'])
      context[name]=(...args)=>canvas.operations.push({name,args});
    canvas.getContext=kind=>kind==='2d'?context:null;canvases.push(canvas);return canvas;
  }
  return {createCanvas,canvases};
}

test('reading orientation metadata only retains explicit known evidence or an exact unknown state',()=>{
  const values=[{status:'unknown',method:'unknown',clockwiseDegrees:null},
    {status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:180},
    {status:'text-upright',method:'page-corners',clockwiseDegrees:180},
    {status:'text-upright',method:'page-corners',clockwiseDegrees:-180},
    {status:'text-upright',method:'rotation',clockwiseDegrees:13.5},
    {status:'text-upright',method:'already-upright',clockwiseDegrees:0},
    {status:'illustration-upright',method:'page-corners',clockwiseDegrees:180},
    {status:'illustration-upright',method:'rotation',clockwiseDegrees:-8.25},
    {status:'illustration-upright',method:'already-upright',clockwiseDegrees:0}];
  for(const expected of values){
    const input={...expected,rawResponse:'not-storage-data'},safe=normalizeReadingOrientation(input);
    assert.deepEqual(safe,expected);assert.notEqual(safe,input);
  }
  for(const input of [undefined,null,[],true,'unknown',{},
    {status:'unknown',method:'unknown'},
    {status:'unknown',method:'unknown',clockwiseDegrees:0},
    {status:'unknown',method:'rotation',clockwiseDegrees:null},
    {status:'text-upright',method:'unknown',clockwiseDegrees:0},
    {status:'illustration-upright',method:'unknown',clockwiseDegrees:0},
    {status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:0},
    {status:'software-rotated',method:'page-corners-plus-180',clockwiseDegrees:-180},
    {status:'software-rotated',method:'page-corners',clockwiseDegrees:180},
    {status:'guessed',method:'rotation',clockwiseDegrees:180},
    ...[undefined,null,NaN,Infinity,'180',181,-181].map(clockwiseDegrees=>
      ({status:'text-upright',method:'rotation',clockwiseDegrees}))])
    assert.equal(normalizeReadingOrientation(input),null);
});

test('software corner ordering uses camera pixel aspect, deterministic ties, and repairs arbitrary input order without reading text',()=>{
  const diamond=[{x:.2,y:.45},{x:.4,y:.1},{x:.8,y:.55},{x:.6,y:.9}];
  const unordered=[diamond[2],diamond[0],diamond[3],diamond[1]],before=structuredClone(unordered);
  const landscape=orderImageQuad(unordered,2000,1000),portrait=orderImageQuad(unordered,1000,2000);
  assert.deepEqual(landscape,diamond);
  assert.deepEqual(portrait,[diamond[1],diamond[2],diamond[3],diamond[0]]);
  assert.deepEqual(unordered,before);
  const tied=[{x:.1,y:.5},{x:.5,y:.1},{x:.9,y:.5},{x:.5,y:.9}];
  assert.deepEqual(orderImageQuad(tied,1000,1000),[tied[1],tied[2],tied[3],tied[0]]);
  for(const points of [[...diamond.slice(0,3),diamond[0]],
    [{x:.1,y:.1},{x:.8,y:.1},{x:.8,y:.8},{x:.6,y:.2}],
    [{x:.1,y:.1},{x:.2,y:.2},{x:.3,y:.3},{x:.4,y:.4}]])
    assert.throws(()=>orderImageQuad(points,1000,1000),/corner|convex/);
});

test('perspective transforms copy only bounded clockwise convex corners',()=>{
  const input={...rect,credentials:'not-storage-data'},safe=normalizePerspectiveTransform(input);
  assert.deepEqual(safe,rect);assert.notEqual(safe.quad,input.quad);safe.quad[0].x=.3;assert.equal(input.quad[0].x,.2);
  assert.equal(normalizePerspectiveTransform(undefined),null);
  assert.deepEqual(normalizePerspectiveTransform({...rect,rotationDegrees:0}),rect);
  assert.equal(normalizePerspectiveTransform({...rect,rotationDegrees:13.5}).rotationDegrees,13.5);
  for(const rotationDegrees of [null,NaN,Infinity,'180',181,-181])
    assert.throws(()=>normalizePerspectiveTransform({...rect,rotationDegrees}),/reading rotation/);
  for(const value of [{type:'unknown',quad:rect.quad},{type:'perspective',quad:[]},
    {type:'perspective',quad:rect.quad.toReversed()},
    {type:'perspective',quad:[rect.quad[0],rect.quad[2],rect.quad[1],rect.quad[3]]},
    {type:'perspective',quad:[{x:-.1,y:0},...rect.quad.slice(1)]},
    {type:'perspective',quad:[{x:NaN,y:0},...rect.quad.slice(1)]},
    {type:'perspective',quad:[{x:0,y:0},{x:.000001,y:0},{x:.000001,y:.000001},{x:0,y:.000001}]}])
    assert.throws(()=>normalizePerspectiveTransform(value),/Perspective/);
});

test('reading-ordered page corners turn 180 and rectify an angled page without changing clockwise anatomy',()=>{
  const upsideDown={type:'perspective',quad:[rect.quad[2],rect.quad[3],rect.quad[0],rect.quad[1]]};
  const geometry=perspectiveOutputGeometry(upsideDown,1000,1000);
  assert.equal(geometry.width,600);assert.equal(geometry.height,800);
  const topLeft=projectPerspective(geometry.matrix,0,0),bottomRight=projectPerspective(geometry.matrix,1,1);
  near(topLeft.x,.8);near(topLeft.y,.9);near(bottomRight.x,.2);near(bottomRight.y,.1);
  const tilted={type:'perspective',quad:[trapezoid.quad[2],trapezoid.quad[3],trapezoid.quad[0],trapezoid.quad[1]]};
  const tiltedGeometry=perspectiveOutputGeometry(tilted,1920,1080);
  for(const [index,[x,y]] of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]]]){
    const point=projectPerspective(tiltedGeometry.matrix,x,y);near(point.x,tilted.quad[index].x);near(point.y,tilted.quad[index].y);
  }
});

test('clockwise rectangular rotations preserve every selected corner and make quarter-turn dimensions exact',()=>{
  for(const [angle,width,height,expected] of [
    [180,600,800,[2,3,0,1]],[90,800,600,[3,0,1,2]],[-90,800,600,[1,2,3,0]],
  ]){
    const geometry=perspectiveOutputGeometry({...rect,rotationDegrees:angle},1000,1000);
    assert.equal(geometry.width,width);assert.equal(geometry.height,height);
    for(const [index,[x,y]] of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]]]){
      const source=projectPerspective(geometry.matrix,x,y),corner=rect.quad[expected[index]];
      near(source.x,corner.x);near(source.y,corner.y);
    }
  }
});

test('slight-angle rotation expands its bounds without cutting content and later crops use upright coordinates',()=>{
  for(const angle of [13.5,-8.25,43,179.5]){
    const transform={...rect,rotationDegrees:angle},geometry=perspectiveOutputGeometry(transform,1000,1000);
    const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
    const w=600,h=800,rw=Math.abs(c)*w+Math.abs(s)*h,rh=Math.abs(s)*w+Math.abs(c)*h;
    assert.equal(geometry.width,Math.ceil(rw));assert.equal(geometry.height,Math.ceil(rh));
    for(const point of [...rect.quad,{x:.5,y:.5},{x:.4,y:.42}]){
      const x=(point.x-.5)*1000,y=(point.y-.5)*1000;
      const u=(c*x-s*y+rw/2)/rw,v=(s*x+c*y+rh/2)/rh;
      assert.ok(u>=-1e-12&&u<=1+1e-12&&v>=-1e-12&&v<=1+1e-12);
      const source=projectPerspective(geometry.matrix,u,v);near(source.x,point.x);near(source.y,point.y);
    }
    const region={x:.25,y:.2,width:.5,height:.6};
    const cropped=perspectiveOutputGeometry(transform,1000,1000,region,{maxWidth:180,maxHeight:140});
    assert.ok(cropped.width<=180&&cropped.height<=140);
    for(const [x,y] of [[0,0],[1,1],[.5,.5]]){
      const expected=projectPerspective(geometry.matrix,region.x+x*region.width,region.y+y*region.height);
      const actual=projectPerspective(cropped.matrix,x,y);near(actual.x,expected.x);near(actual.y,expected.y);
    }
  }
  const bounded=perspectiveOutputGeometry({...rect,rotationDegrees:13.5},32768,32768,{x:.49,y:.49,width:.02,height:.02});
  assert.ok(bounded.rotation.base.width<=2048&&bounded.rotation.base.height<=2048,'tiny user crops cannot allocate giant intermediates');
});

test('rotated canvas output only draws the selected intermediate, leaving expanded corners neutral',()=>{
  const h=canvasFactory(),input={width:1000,height:1000},geometry=perspectiveOutputGeometry({...rect,rotationDegrees:13.5},1000,1000);
  const output=h.createCanvas();output.width=geometry.width;output.height=geometry.height;
  assert.equal(renderPerspectiveFrame(input,output,geometry,{createCanvas:h.createCanvas,preferGPU:false}),'canvas-mesh+rotation');
  const draws=output.operations.filter(op=>op.name==='drawImage');assert.equal(draws.length,1);
  const intermediate=draws[0].args[0];assert.notEqual(intermediate,input);
  assert.ok(intermediate.operations.filter(op=>op.name==='drawImage').every(op=>op.args[0]===input));
  assert.equal(intermediate.operations.filter(op=>op.name==='drawImage').length,2,'only the bounded rectangular source is sampled');
  assert.ok(output.operations.some(op=>op.name==='clearRect'&&op.args[2]===output.width&&op.args[3]===output.height));
  const matrix=output.operations.filter(op=>op.name==='setTransform')[1].args;
  assert.ok(matrix[1]>0&&matrix[2]<0,'positive correction rotates clockwise in canvas coordinates');
  const before=h.canvases.length,next=h.createCanvas();next.width=geometry.width;next.height=geometry.height;
  renderPerspectiveFrame(input,next,geometry,{createCanvas:h.createCanvas,preferGPU:false});
  assert.equal(h.canvases.length,before+1,'all pins reuse one bounded rotation intermediate');
  assert.equal(next.operations.find(op=>op.name==='drawImage').args[0],intermediate);
  assert.equal(intermediate.width,1);assert.equal(intermediate.height,1,'transient camera pixels clear after the draw');
});

test('a failed final rotation releases its shared scratch image before a later retry',()=>{
  const h=canvasFactory(),input={width:1000,height:1000},geometry=perspectiveOutputGeometry({...rect,rotationDegrees:-8.25},1000,1000);
  const output=h.createCanvas();output.width=geometry.width;output.height=geometry.height;
  output.getContext('2d').drawImage=()=>{throw new Error('Draw failed');};
  assert.throws(()=>renderPerspectiveFrame(input,output,geometry,{createCanvas:h.createCanvas,preferGPU:false}),/Draw failed/);
  const intermediate=h.canvases[1];assert.equal(intermediate.width,1);assert.equal(intermediate.height,1);
  const retry=h.createCanvas();retry.width=geometry.width;retry.height=geometry.height;
  assert.equal(renderPerspectiveFrame(input,retry,geometry,{createCanvas:h.createCanvas,preferGPU:false}),'canvas-mesh+rotation');
  assert.equal(retry.operations.find(op=>op.name==='drawImage').args[0],intermediate);
  assert.equal(h.canvases.length,3,'failed frames do not leak another rotation surface');
});

test('the homography maps every rectangle corner to the actual model-selected quad without mirroring',()=>{
  for(const transform of [rect,trapezoid]){
    const matrix=perspectiveMatrix(transform);
    for(const [index,[x,y]] of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]]]){
      const projected=projectPerspective(matrix,x,y);near(projected.x,transform.quad[index].x);near(projected.y,transform.quad[index].y);
    }
    const center=projectPerspective(matrix,.5,.5);assert.ok(center.x>.1&&center.x<.9&&center.y>.1&&center.y<.91);
  }
});

test('portrait correction and later region crops preserve aspect and compose in rectified coordinates',()=>{
  const portrait=perspectiveOutputGeometry(rect,512,640),landscape=perspectiveOutputGeometry(rect,1920,1080);
  assert.equal(portrait.width,307);assert.equal(portrait.height,512);assert.ok(landscape.width>landscape.height);
  const crop={x:.1,y:.2,width:.6,height:.5},geometry=perspectiveOutputGeometry(trapezoid,512,640,crop,{maxWidth:150,maxHeight:180});
  assert.ok(geometry.width<=150&&geometry.height<=180);
  const source=perspectiveMatrix(trapezoid);
  for(const [x,y] of [[0,0],[1,0],[1,1],[0,1],[.4,.6]]){
    const expected=projectPerspective(source,crop.x+x*crop.width,crop.y+y*crop.height),actual=projectPerspective(geometry.matrix,x,y);
    near(actual.x,expected.x);near(actual.y,expected.y);
  }
  assert.throws(()=>perspectiveOutputGeometry(rect,0,640),/dimensions/);
  assert.throws(()=>perspectiveOutputGeometry(rect,512,640,{x:.9,y:0,width:.2,height:1}),/crop/);
});

test('the bounded Canvas fallback draws real camera pixels and caches fixed triangle geometry',()=>{
  const h=canvasFactory(),input={width:512,height:640},geometry=perspectiveOutputGeometry(trapezoid,512,640),output=h.createCanvas();
  output.width=geometry.width;output.height=geometry.height;
  assert.equal(renderPerspectiveFrame(input,output,geometry,{createCanvas:h.createCanvas,preferGPU:false}),'canvas-mesh');
  const draws=output.operations.filter(op=>op.name==='drawImage'),matrices=output.operations.filter(op=>op.name==='setTransform');
  assert.equal(draws.length,128);assert.ok(draws.every(op=>op.args[0]===input));assert.ok(matrices.every(op=>op.args.every(Number.isFinite)));
  const second=h.createCanvas();second.width=geometry.width;second.height=geometry.height;
  renderPerspectiveFrame(input,second,geometry,{createCanvas:h.createCanvas,preferGPU:false});
  assert.deepEqual(second.operations.filter(op=>op.name==='setTransform'),matrices);
  const flat=perspectiveOutputGeometry(rect,512,640),third=h.createCanvas();third.width=flat.width;third.height=flat.height;
  renderPerspectiveFrame(input,third,flat,{createCanvas:h.createCanvas,preferGPU:false});
  assert.equal(third.operations.filter(op=>op.name==='drawImage').length,2,'affine camera surfaces need only two exact triangles');
});

test('Canvas mesh clipping overlaps every edge by a full output pixel even for thin and diagonal triangles',()=>{
  const h=canvasFactory(),input={width:1920,height:1080};
  for(const [transform,region,limits] of [
    [rect,full,{maxWidth:700,maxHeight:700}],
    [rect,{x:0,y:0,width:1,height:.0005},{maxWidth:1500,maxHeight:20}],
    [rect,{x:0,y:0,width:.0005,height:1},{maxWidth:20,maxHeight:1000}],
    [trapezoid,full,{maxWidth:900,maxHeight:700}],
    [trapezoid,{x:0,y:0,width:1,height:.002},{maxWidth:1000,maxHeight:8}],
    [trapezoid,{x:0,y:0,width:.002,height:1},{maxWidth:8,maxHeight:1000}],
  ]){
    const geometry=perspectiveOutputGeometry(transform,input.width,input.height,region,limits),output=h.createCanvas();
    output.width=geometry.width;output.height=geometry.height;
    renderPerspectiveFrame(input,output,geometry,{createCanvas:h.createCanvas,preferGPU:false});
    const paths=[];let path;
    for(const operation of output.operations){
      if(operation.name==='moveTo'){path=[{x:operation.args[0],y:operation.args[1]}];paths.push(path);}
      if(operation.name==='lineTo')path.push({x:operation.args[0],y:operation.args[1]});
    }
    const affine=Math.abs(geometry.matrix[6])+Math.abs(geometry.matrix[7])<1e-9;
    const columns=affine?1:Math.min(16,Math.max(8,Math.ceil(output.width/100)));
    const rows=affine?1:Math.min(16,Math.max(8,Math.ceil(output.height/100)));
    const mappings=output.operations.filter(op=>op.name==='setTransform').slice(1);
    assert.equal(paths.length,2*columns*rows);
    let index=0;
    for(let row=0;row<rows;row++)for(let column=0;column<columns;column++){
      const at=(x,y)=>({x:x/columns*output.width,y:y/rows*output.height});
      const a=at(column,row),b=at(column+1,row),c=at(column+1,row+1),d=at(column,row+1);
      for(const triangle of [[a,b,c],[a,c,d]]){
        const expanded=paths[index],matrix=mappings[index].args;index++;
        for(let edge=0;edge<3;edge++){
          const start=triangle[edge],end=triangle[(edge+1)%3],dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy);
          const nx=dy/length,ny=-dx/length;
          // Both endpoints lie on a parallel line a full pixel OUTSIDE the
          // original clip, including each mesh cell's internal diagonal.
          for(const point of [expanded[edge],expanded[(edge+1)%3]])
            near(nx*(point.x-start.x)+ny*(point.y-start.y),1);
        }
        // Expansion must not scale the sampled camera pixels to fill the
        // larger clip. The original vertices retain their exact mapping.
        for(const point of triangle){
          const source=projectPerspective(geometry.matrix,point.x/output.width,point.y/output.height);
          near(matrix[0]*source.x*input.width+matrix[2]*source.y*input.height+matrix[4],point.x);
          near(matrix[1]*source.x*input.width+matrix[3]*source.y*input.height+matrix[5],point.y);
        }
      }
    }
  }
});

test('degenerate output mesh triangles fail before nonfinite clipping paths can reach Canvas',()=>{
  const h=canvasFactory(),input={width:512,height:640};
  for(const [width,height] of [[0,100],[100,0],[NaN,100],[100,Infinity]]){
    const output=h.createCanvas();output.width=width;output.height=height;
    const geometry={width,height,matrix:perspectiveMatrix(rect)};
    assert.throws(()=>renderPerspectiveFrame(input,output,geometry,{createCanvas:h.createCanvas,preferGPU:false}),/surface is too narrow/);
    assert.equal(output.operations.some(operation=>operation.name==='moveTo'),false);
  }
});

test('a perspective source owns one existing lease, leaves raw metadata unchanged, and releases transient frames',()=>{
  const h=canvasFactory(),rawFrames=[],calls=[],renders=[];let stops=0,live=true;
  const raw={id:'shared-camera',kind:'aux-camera',deviceId:'cpd',label:'CPD',stream:{id:'one-existing-stream'},
    getMetadata:()=>({width:512,height:640}),isActive:()=>live,
    capture(region,limits){calls.push({region,limits});const frame=h.createCanvas();frame.width=512;frame.height=640;rawFrames.push(frame);return frame;},stop(){stops++;}};
  const wrapper=createPerspectiveCaptureSource(raw,trapezoid,{createCanvas:h.createCanvas,render:(input,output,geometry)=>renders.push({input,output,geometry})});
  assert.equal(wrapper.stream,raw.stream);assert.equal(wrapper.kind,'aux-camera');assert.deepEqual(wrapper.getMetadata(),{width:512,height:640});
  assert.deepEqual(wrapper.resumeHint.transform,trapezoid);assert.equal(wrapper.resumeHint.width,512);assert.equal(wrapper.resumeHint.height,640);
  const first=wrapper.capture(),second=wrapper.capture();
  assert.notEqual(first,second);assert.equal(renders[0].geometry,renders[1].geometry,'the fixed transform is reused between frames');
  assert.deepEqual(calls[0],{region:full,limits:{maxWidth:2048,maxHeight:2048}});
  const crop={x:.1,y:.2,width:.6,height:.5},cropped=wrapper.capture(crop,{maxWidth:150,maxHeight:180});
  assert.ok(cropped.width<=150&&cropped.height<=180);assert.notEqual(renders[2].geometry,renders[1].geometry);
  assert.ok(rawFrames.every(frame=>frame.width===1&&frame.height===1));assert.equal(stops,0);
  assert.equal(createPerspectiveCaptureSource(wrapper,trapezoid),wrapper,'matching wrappers are never nested');
  assert.throws(()=>createPerspectiveCaptureSource(wrapper,rect),/different perspective/);
  wrapper.stop();wrapper.stop();assert.equal(stops,1);assert.equal(wrapper.isActive(),false);assert.equal(wrapper.stream,null);
  assert.ok(first.width>1&&first.height>1,'the pin retains its last real preview after sharing ends');
  assert.throws(()=>wrapper.capture(),/no longer active/);assert.equal(calls.length,3);
});

test('renderer failure releases scratch pixels, never a shared track, and source lifetime remains explicit',()=>{
  const h=canvasFactory();let stops=0;
  const raw={kind:'camera',label:'Main RGB',isActive:()=>true,capture(){const frame=h.createCanvas();frame.width=512;frame.height=640;return frame;},stop(){stops++;}};
  const wrapper=createPerspectiveCaptureSource(raw,rect,{createCanvas:h.createCanvas,render(){throw new Error('Renderer unavailable.');}});
  assert.throws(()=>wrapper.capture(),/Renderer unavailable/);assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));
  assert.equal(stops,0);assert.equal(wrapper.resumeHint,null);wrapper.stop();assert.equal(stops,1);
});

test('source replacement during frame acquisition cannot return an obsolete rectified image',()=>{
  const h=canvasFactory();let live=true,stops=0;
  const raw={kind:'camera',isActive:()=>live,capture(){const frame=h.createCanvas();frame.width=512;frame.height=640;return frame;},stop(){stops++;}};
  const wrapper=createPerspectiveCaptureSource(raw,rect,{createCanvas:h.createCanvas,render(){live=false;}});
  assert.throws(()=>wrapper.capture(),/camera changed/);assert.ok(h.canvases.every(canvas=>canvas.width===1&&canvas.height===1));assert.equal(stops,0);
  wrapper.stop();assert.equal(stops,1);
});
