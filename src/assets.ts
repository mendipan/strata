import { inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { assetDescriptorSchema, bytesDigest, canonical, CONTENT_MODEL, digest, fail, parse, type Records, type Snapshot } from './model.js';

export const ASSET_LIMITS = { bytes: 4 * 1024 * 1024, axis: 4096, pixels: 16_000_000, versions: 32, retainedBytes: 16 * 1024 * 1024, descriptorBytes: 8192 } as const;
export interface ByteStore { read(hash: string): Promise<Uint8Array>; put(hash: string, bytes: Uint8Array): Promise<void>; }
export function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function dimensions(width: number, height: number) { if (!width || !height || width > ASSET_LIMITS.axis || height > ASSET_LIMITS.axis || width * height > ASSET_LIMITS.pixels) fail('INVALID_ASSET', 2, 'Image dimensions exceed the assets/1 bounds.'); return { width, height }; }
export function inspectImage(input: Uint8Array): { media_type: 'image/png'|'image/jpeg'; width: number; height: number } {
  if (!input.length || input.length > ASSET_LIMITS.bytes) fail('INVALID_ASSET', 2, 'assets/1 accepts at most 4 MiB per image.');
  const b = Buffer.from(input); const invalid = () => fail('INVALID_ASSET', 2, 'Unsupported or malformed bounded PNG/JPEG structure.');
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let at = 8, width = 0, height = 0, channels = 0, seenData = false, endedData = false, ended = false; const compressed: Buffer[] = [];
    while (at < b.length) {
      if (at + 12 > b.length) invalid(); const length = b.readUInt32BE(at); if (length > b.length - at - 12) invalid();
      const kind = b.toString('ascii', at+4, at+8), body = b.subarray(at+8, at+8+length);
      if (!/^[A-Za-z]{4}$/.test(kind) || crc32(b.subarray(at+4, at+8+length)) !== b.readUInt32BE(at+8+length)) invalid();
      if (at === 8 && kind !== 'IHDR') invalid();
      if (kind === 'IHDR') { if (at !== 8 || length !== 13 || body[8] !== 8 || ![0,2,4,6].includes(body[9]) || body[10] || body[11] || body[12]) invalid(); width=body.readUInt32BE(0); height=body.readUInt32BE(4); dimensions(width,height); channels = ({0:1,2:3,4:2,6:4} as Record<number,number>)[body[9]]; }
      else if (kind === 'IDAT') { if (endedData) invalid(); seenData=true; compressed.push(body); }
      else if (kind === 'IEND') { if (length || !seenData || at+12 !== b.length) invalid(); ended=true; break; }
      else { if (seenData) endedData=true; if (['acTL','fcTL','fdAT','PLTE'].includes(kind) || kind[0] === kind[0].toUpperCase()) invalid(); }
      at += length + 12;
    }
    if (!ended) invalid();
    const stride = width * channels + 1; let decoded: Buffer;
    try { const result = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height, info: true }) as unknown as {buffer:Buffer;engine:{bytesWritten:number}}; decoded=result.buffer; if (result.engine.bytesWritten !== Buffer.concat(compressed).length) invalid(); } catch { invalid(); }
    if (decoded!.length !== stride * height) invalid(); for (let row=0; row<height; row++) if (decoded![row*stride] > 4) invalid();
    return { media_type: 'image/png', width, height };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let at=2, width=0, height=0, frame=false, scan=false, quant=false, huffman=false; let components: number[]=[];
    while (at < b.length) {
      if (b[at++] !== 0xff) invalid(); while (b[at] === 0xff) at++; const marker=b[at++];
      if (marker === 0xd9) { if (!scan || at !== b.length) invalid(); return { media_type: 'image/jpeg', ...dimensions(width,height) }; }
      if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || at+2 > b.length) invalid();
      const length=b.readUInt16BE(at); if (length<2 || at+length>b.length) invalid(); const body=b.subarray(at+2,at+length); at+=length;
      if (marker === 0xc0) { if (frame || body.length<6 || body[0]!==8 || ![1,3].includes(body[5]) || body.length!==6+3*body[5]) invalid(); height=body.readUInt16BE(1); width=body.readUInt16BE(3); dimensions(width,height); components=Array.from({length:body[5]},(_,n)=>body[6+n*3]); if(new Set(components).size!==components.length) invalid(); for(let n=0;n<body[5];n++) if(!(body[7+n*3]>>4) || !(body[7+n*3]&15) || (body[7+n*3]>>4)>4 || (body[7+n*3]&15)>4 || body[8+n*3]>3) invalid(); frame=true; }
      else if (marker===0xdb) { let p=0; while(p<body.length) { const table=body[p++]; if((table>>4)!==0 || (table&15)>3 || p+64>body.length) invalid(); for(let n=0;n<64;n++) if(!body[p+n]) invalid(); p+=64; } if(!body.length) invalid(); quant=true; }
      else if (marker===0xc4) { let p=0; while(p<body.length) { if(p+17>body.length) invalid(); const table=body[p++]; if((table>>4)>1 || (table&15)>3) invalid(); let count=0, slots=1; for(let n=0;n<16;n++) { slots=slots*2-body[p+n]; if(slots<0) invalid(); count+=body[p+n]; } p+=16; if(!count || count>256 || p+count>body.length) invalid(); p+=count; } if(!body.length) invalid(); huffman=true; }
      else if (marker===0xda) { if(!frame || !quant || !huffman || scan || body.length<6 || body[0]!==components.length || body.length!==4+2*body[0]) invalid(); for(let n=0;n<body[0];n++) if(!components.includes(body[1+2*n]) || (body[2+2*n]>>4)>3 || (body[2+2*n]&15)>3) invalid(); if(body.at(-3)!==0 || body.at(-2)!==63 || body.at(-1)!==0) invalid(); scan=true; let data=0; while(at<b.length) { if(b[at]!==0xff) {at++;data++;continue;} if(b[at+1]===0) {at+=2;data++;continue;} if(b[at+1]>=0xd0 && b[at+1]<=0xd7) {at+=2;continue;} break; } if(!data) invalid(); }
      else if (!(marker>=0xe0 && marker<=0xef) && marker!==0xfe && marker!==0xdd) invalid();
      else if(marker===0xdd && body.length!==2) invalid();
    }
  }
  return invalid();
}
export function checkAssets(records: Records, bytes: Map<string,Uint8Array>|undefined, projectId: string|undefined) {
  const descriptors=Object.entries(records).filter(([,r])=>r.type==='asset'); if(descriptors.length>ASSET_LIMITS.versions) fail('ASSET_QUOTA',2,'At most 32 retained asset versions are supported.');
  const unique=new Map<string,number>();
  for(const [ref,r] of descriptors) { const d=parse(assetDescriptorSchema,r.data); if(ref!=='asset@'+digest(d) || !r.published || Buffer.byteLength(canonical(d))>ASSET_LIMITS.descriptorBytes || !projectId || d.project_id!==projectId) fail('INVALID_ASSET',2,'Asset identity, descriptor bound or project binding is inconsistent.');
    if(!bytes) fail('UNSUPPORTED_ASSET_BACKEND',8,'A bounded binary ByteStore is required for retained assets.'); const blob=bytes.get(d.content_sha256); if(!blob || blob.length!==d.byte_length || bytesDigest(blob)!==d.content_sha256 || canonical(inspectImage(blob))!==canonical({media_type:d.media_type,width:d.width,height:d.height})) fail('ASSET_INTEGRITY',6,'Retained asset bytes do not match the pinned descriptor.',{ref});
    const previous=d.previous ? records[d.previous] : undefined; if(d.revision===1 ? d.previous!==null : !previous || previous.type!=='asset' || previous.data.id!==d.id || previous.data.revision!==d.revision-1) fail('INVALID_ASSET',2,'Asset revisions need an exact retained predecessor.'); unique.set(d.content_sha256,d.byte_length);
  }
  if([...unique.values()].reduce((a,b)=>a+b,0)>ASSET_LIMITS.retainedBytes) fail('ASSET_QUOTA',2,'Retained unique asset bytes exceed 16 MiB.');
  const identities=new Set<string>(); for(const [,r] of descriptors) { const key=r.data.id+'@'+r.data.revision; if(identities.has(key)) fail('INVALID_ASSET',2,'Duplicate logical asset revision.'); identities.add(key); }
}
export function checkAssetClosure(snapshot: Snapshot, records: Records, bytes?: Map<string,Uint8Array>, projectId?: string) {
  if(snapshot.model_version!==CONTENT_MODEL) return;
  const pins=Object.values(snapshot.blocks).flatMap(b=>Object.values(b.asset_refs ?? {}));
  if(pins.length && !bytes) fail('UNSUPPORTED_ASSET_BACKEND',8,'Asset-bearing intent requires a bounded binary ByteStore; SDK binary retention is unavailable.');
  checkAssets(records,bytes,projectId);
  for(const block of Object.values(snapshot.blocks)) for(const pin of Object.values(block.asset_refs ?? {})) { const record=records[pin.asset_ref]; if(!record || record.type!=='asset' || !record.published) fail('ASSET_NOT_FOUND',3,'Exact retained asset descriptor is absent.'); if(record.data.content_sha256!==pin.content_sha256) fail('ASSET_INTEGRITY',6,'Block asset hash does not match its exact descriptor.'); }
}
