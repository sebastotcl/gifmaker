const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');

const port=process.env.PORT||3000;
const indexPath=path.join(__dirname,'public','index.html');

const server=http.createServer((req,res)=>{
    if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
        fs.readFile(indexPath,(error,html)=>{
            if(error){
                res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});
                return res.end('No se pudo cargar GIF Maker.');
            }
            res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
            res.end(html);
        });
        return;
    }

    res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok:false,message:'Ruta no disponible.'}));
});

server.listen(port,'0.0.0.0',()=>{
    console.log(`GIF Maker escuchando en puerto ${port}`);
});
