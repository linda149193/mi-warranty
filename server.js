// 本機預覽用(純靜態)。正式使用請部署到 GitHub Pages。
const http=require('http'),fs=require('fs'),path=require('path');
const P=path.join(__dirname,'public'),T={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png'};
http.createServer((q,r)=>{let u=new URL(q.url,'http://x').pathname;let p=path.normalize(path.join(P,u==='/'?'index.html':decodeURIComponent(u)));
if(!p.startsWith(P)||!fs.existsSync(p)||fs.statSync(p).isDirectory()){r.writeHead(404);return r.end('Not found')}
r.writeHead(200,{'content-type':T[path.extname(p)]||'application/octet-stream'});fs.createReadStream(p).pipe(r)}).listen(process.env.PORT||3000,()=>console.log('http://localhost:3000'));
