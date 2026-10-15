'use strict';
const http=require('node:http');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const Busboy=require('busboy');
const sharp=require('sharp');
const GIFEncoder=require('gif-encoder-2');

const PORT=Number(process.env.PORT)||3000;
const ROOT=__dirname;
const INDEX=path.join(ROOT,'public','index.html');
const OUTPUT_DIR=path.join(os.tmpdir(),'protool-gifmaker-generated');
const MAX_UPLOAD=100*1024*1024;
const MAX_FILES=20;
const MAX_PIXELS=1920*1920;
const OUTPUT_TTL=60*60*1000;
let activeJobs=0;
const MAX_JOBS=1;

function json(res,status,body){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}
function fail(message,status=400){const e=new Error(message);e.status=status;return e;}
function clamp(value,defaultValue,min,max){
  if(value===undefined||value==='')return defaultValue;
  if(!/^-?\d+$/.test(String(value)))throw fail('Las medidas o la duración no son válidas.');
  return Math.max(min,Math.min(max,Number(value)));
}
function settings(fields){
  const width=clamp(fields.width,600,200,1920);
  const height=clamp(fields.height,350,200,1920);
  const duration=clamp(fields.duration,2500,300,10000);
  const colors=clamp(fields.colors,128,32,256);
  const mode=['cover','contain'].includes(fields.mode)?fields.mode:'cover';
  const background=/^#[0-9a-fA-F]{6}$/.test(fields.background||'')?fields.background:'#1a1a1a';
  const loop=fields.loop===undefined?0:Number(fields.loop);
  if(![-1,0,3,5].includes(loop))throw fail('La repetición seleccionada no es válida.');
  return {width,height,duration,colors,mode,background,loop};
}
async function receive(req){
  const type=req.headers['content-type']||'';
  if(!type.startsWith('multipart/form-data'))throw fail('Debes seleccionar imágenes.');
  const files=[];
  const fields={};
  let bytes=0;
  let rejected=null;
  const bb=Busboy({headers:req.headers,limits:{files:MAX_FILES+1,fileSize:MAX_UPLOAD,fields:12,fieldSize:256,parts:MAX_FILES+13}});
  await new Promise((resolve,reject)=>{
    bb.on('field',(name,value)=>{if(['width','height','duration','colors','mode','background','loop'].includes(name))fields[name]=value;});
    bb.on('file',(name,stream,info)=>{
      const chunks=[];
      let size=0;
      if(name!=='images'||files.length>=MAX_FILES){rejected=rejected||fail('Puedes utilizar un máximo de 20 imágenes.');stream.resume();return;}
      const filename=info.filename||'';
      const ext=path.extname(filename).toLowerCase();
      const valid=['.png','.jpg','.jpeg','.webp'].includes(ext);
      stream.on('limit',()=>{rejected=fail('Las imágenes superan el límite total de 100 MB.',413);});
      stream.on('data',chunk=>{
        size+=chunk.length;
        bytes+=chunk.length;
        if(bytes>MAX_UPLOAD)rejected=fail('Las imágenes superan el límite total de 100 MB.',413);
        if(!rejected&&valid)chunks.push(chunk);
      });
      stream.on('end',()=>{if(valid&&size>0&&!rejected)files.push(Buffer.concat(chunks));});
    });
    bb.on('filesLimit',()=>{rejected=fail('Puedes utilizar un máximo de 20 imágenes.');});
    bb.on('partsLimit',()=>{rejected=fail('Demasiados campos en la solicitud.');});
    bb.on('error',reject);
    bb.on('close',()=>rejected?reject(rejected):resolve());
    req.on('aborted',()=>reject(fail('Carga interrumpida.')));
    req.pipe(bb);
  });
  if(files.length<2)throw fail('Debes seleccionar al menos dos imágenes compatibles.');
  return {files,fields};
}
async function generate(req,res){
  if(activeJobs>=MAX_JOBS){json(res,503,{ok:false,message:'GIF Maker está procesando otra animación. Intenta nuevamente en unos segundos.'});req.resume();return;}
  activeJobs++;
  try{
    const {files,fields}=await receive(req);
    const {width,height,duration,colors,mode,background,loop}=settings(fields);
    const encoder=new GIFEncoder(width,height,'neuquant',false,files.length);
    encoder.setRepeat(loop);
    encoder.setDelay(duration);
    encoder.setQuality(Math.max(1,Math.round(256/colors)));
    encoder.start();
    for(const file of files){
      const meta=await sharp(file,{limitInputPixels:40_000_000,animated:false}).metadata();
      if(!['png','jpeg','webp'].includes(meta.format))throw fail('No encontramos suficientes imágenes compatibles.');
      const pipeline=sharp(file,{limitInputPixels:40_000_000,animated:false}).rotate().resize(width,height,{
        fit:mode==='cover'?'cover':'contain',position:'centre',background
      }).flatten({background}).ensureAlpha().raw();
      const {data,info}=await pipeline.toBuffer({resolveWithObject:true});
      if(info.width!==width||info.height!==height||info.channels!==4)throw fail('No pudimos preparar una imagen.');
      encoder.addFrame(data);
    }
    encoder.finish();
    const output=encoder.out.getData();
    const filename=`gif_${crypto.randomUUID().replace(/-/g,'')}.gif`;
    await fsp.mkdir(OUTPUT_DIR,{recursive:true,mode:0o700});
    await fsp.writeFile(path.join(OUTPUT_DIR,filename),output,{flag:'wx',mode:0o600});
    json(res,200,{ok:true,filename,preview:`/generated/${filename}`,download:`/download/${filename}`,size_mb:Math.round(output.length/1024/1024*100)/100,width,height,frames:files.length});
  }catch(error){
    console.error('GIF generation failed:',error);
    json(res,error.status||500,{ok:false,message:error.status?error.message:'No pudimos generar el GIF. Revisa las imágenes.'});
  }finally{activeJobs--;}
}
async function serveGif(res,filename,download){
  if(!/^gif_[a-f0-9]{32}\.gif$/.test(filename)){json(res,404,{ok:false,message:'GIF no encontrado.'});return;}
  try{
    const file=path.join(OUTPUT_DIR,filename);
    const stat=await fsp.stat(file);
    if(Date.now()-stat.mtimeMs>OUTPUT_TTL){await fsp.unlink(file).catch(()=>{});json(res,404,{ok:false,message:'GIF expirado.'});return;}
    res.writeHead(200,{'Content-Type':'image/gif','Content-Length':stat.size,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff',...(download?{'Content-Disposition':'attachment; filename="animacion.gif"'}:{})});
    fs.createReadStream(file).pipe(res);
  }catch{json(res,404,{ok:false,message:'GIF no encontrado.'});}
}
async function cleanup(){
  try{for(const name of await fsp.readdir(OUTPUT_DIR)){
    if(!/^gif_[a-f0-9]{32}\.gif$/.test(name))continue;
    const file=path.join(OUTPUT_DIR,name);
    const stat=await fsp.stat(file).catch(()=>null);
    if(stat&&Date.now()-stat.mtimeMs>OUTPUT_TTL)await fsp.unlink(file).catch(()=>{});
  }}catch(error){if(error.code!=='ENOENT')console.error('Cleanup:',error);}
}
const timer=setInterval(cleanup,15*60*1000);timer.unref();
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){
    fs.readFile(INDEX,(error,html)=>error?json(res,500,{ok:false,message:'No se pudo cargar GIF Maker.'}):(res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'}),res.end(html)));
  }else if(req.method==='POST'&&url.pathname==='/generate'){
    const length=Number(req.headers['content-length']);
    if(Number.isFinite(length)&&length>MAX_UPLOAD+1024*1024){json(res,413,{ok:false,message:'Las imágenes superan el límite total de 100 MB.'});req.resume();return;}
    generate(req,res);
  }else if(req.method==='GET'&&(url.pathname.startsWith('/generated/')||url.pathname.startsWith('/download/'))){
    const download=url.pathname.startsWith('/download/');
    serveGif(res,url.pathname.split('/').pop(),download);
  }else json(res,404,{ok:false,message:'Ruta no disponible.'});
});
server.requestTimeout=120000;
server.listen(PORT,'0.0.0.0',()=>console.log(`GIF Maker escuchando en puerto ${PORT}`));
