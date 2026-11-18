// Stored ZIP records and CRC checksums. Input paths are chosen by the workbench.
export function storedZip(entries) {
  const encoder=new TextEncoder();
  const chunks=[], directory=[];
  let offset=0, directorySize=0;
  function crc32(bytes) {
    let crc=0xffffffff;
    for (const value of bytes) {
      crc^=value;
      for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    return (crc^0xffffffff)>>>0;
  }
  for (const [path,bytes] of entries) {
    const name=encoder.encode(path);
    const checksum=crc32(bytes);
    const local=new Uint8Array(30+name.length), l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true); l.setUint16(4,20,true); l.setUint16(6,0x0800,true);
    l.setUint16(12,33,true); l.setUint32(14,checksum,true); l.setUint32(18,bytes.length,true);
    l.setUint32(22,bytes.length,true); l.setUint16(26,name.length,true); local.set(name,30);
    const file=new Uint8Array(46+name.length), f=new DataView(file.buffer);
    f.setUint32(0,0x02014b50,true); f.setUint16(4,20,true); f.setUint16(6,20,true);
    f.setUint16(8,0x0800,true); f.setUint16(14,33,true); f.setUint32(16,checksum,true);
    f.setUint32(20,bytes.length,true); f.setUint32(24,bytes.length,true); f.setUint16(28,name.length,true);
    f.setUint32(42,offset,true); file.set(name,46);
    chunks.push(local,bytes);
    directory.push(file);
    offset+=local.length+bytes.length;
    directorySize+=file.length;
  }
  const end=new Uint8Array(22), e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true); e.setUint16(8,entries.length,true); e.setUint16(10,entries.length,true);
  e.setUint32(12,directorySize,true); e.setUint32(16,offset,true);
  return new Blob([...chunks,...directory,end],{type:'application/zip'});
}
