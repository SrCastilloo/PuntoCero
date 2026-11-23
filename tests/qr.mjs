import jsQR from 'jsqr';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const svg=await fs.readFile('tests/test-qr.svg','utf8');
const size=Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
const pixels=new Uint8ClampedArray(size*size*4).fill(255);
for(const match of svg.matchAll(/M(\d+),(\d+)l(\d+),0 0,(\d+) /g)){
 const [,x,y,w,h]=match.map(Number);
 for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++){const n=(row*size+col)*4;pixels[n]=pixels[n+1]=pixels[n+2]=0;}
}
const result=jsQR(pixels,size,size);
assert.equal(result?.data,'https://punto-cero-migration-test.pages.dev/');
console.log('PASS: independent QR decoder reads the new host and root path.');
