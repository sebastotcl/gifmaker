const http=require('node:http');
const port=process.env.PORT||3000;
const server=http.createServer((req,res)=>{
res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
res.end('GIF Maker - ProTool | Node.js funcionando');
});
server.listen(port,'0.0.0.0',()=>{
console.log(`GIF Maker escuchando en puerto ${port}`);
});
