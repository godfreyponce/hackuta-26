import type { FastifyInstance } from 'fastify';

// GET /dev/forge — upload a photo, see the vision JSON, the crop (thumb) and a 3D preview. Dev only.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Forge Lab</title>
<script type="module" src="https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<style>
 body{font:15px system-ui;background:#16130f;color:#eadfc8;margin:0;padding:16px;max-width:900px}
 h1{font-family:Georgia,serif;color:#d4a24c} button,input{font:inherit}
 pre{background:#221d17;padding:12px;border-radius:6px;overflow:auto;max-height:320px}
 .row{display:flex;gap:16px;flex-wrap:wrap} img{max-width:260px;border-radius:6px;background:#fff}
 model-viewer{width:320px;height:320px;background:#221d17;border-radius:6px}
</style></head><body>
<h1>Forge Lab</h1>
<p>Session id (24 hex) <input id="sid" size="28"> <input type="file" id="f" accept="image/*"> <button id="go">Forge</button></p>
<div id="status"></div>
<div class="row"><pre id="out">—</pre><div><img id="thumb"><br><model-viewer id="mv" camera-controls auto-rotate></model-viewer></div></div>
<script>
const $=id=>document.getElementById(id);
$('sid').value = localStorage.getItem('forge-sid') || [...crypto.getRandomValues(new Uint8Array(12))].map(b=>b.toString(16).padStart(2,'0')).join('');
let ws;
function connect(){
  const sid=$('sid').value; localStorage.setItem('forge-sid',sid);
  ws?.close(); ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws?role=web&sessionId='+sid);
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.type==='forge.progress') $('status').textContent='forge: '+m.stage+' '+m.pct+'%';
    if(m.type==='weapon.spawn'){ $('status').textContent='spawned'+(m.weapon.fallback?' (prefab fallback)':'');
      $('out').textContent+= '\\n\\nweapon.spawn '+JSON.stringify(m.weapon,null,2);
      if(m.weapon.thumbUrl) $('thumb').src=m.weapon.thumbUrl; $('mv').src=m.weapon.glbUrl; }};
}
connect(); $('sid').onchange=connect;
$('go').onclick=async()=>{
  const file=$('f').files[0]; if(!file) return;
  const fd=new FormData(); fd.append('sessionId',$('sid').value); fd.append('source','test'); fd.append('debug','1'); fd.append('image',file);
  $('status').textContent='vision…'; const t=performance.now();
  const r=await fetch('/api/forge',{method:'POST',body:fd}); const j=await r.json();
  $('out').textContent='HTTP '+r.status+' in '+Math.round(performance.now()-t)+' ms\\n'+JSON.stringify(j,null,2);
};
</script></body></html>`;

export async function devRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dev/forge', async (_req, reply) => reply.type('text/html').send(PAGE));
}
