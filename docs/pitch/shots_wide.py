"""Prints dos slides no formato da tela do evento: CSS 1920x540 renderizado a 2x = 3840x1080 PNG."""
import json,urllib.request,time,base64,sys,os
def post(p,b):
    r=urllib.request.Request('http://127.0.0.1:9333/'+p,data=json.dumps(b).encode(),headers={'content-type':'application/json'})
    try:
        return json.loads(urllib.request.urlopen(r,timeout=180).read().decode())
    except urllib.error.URLError:
        raise SystemExit('daemon cdpd fora do ar em 127.0.0.1:9333.\nSuba com: node tools/cdpd.mjs &   (e, no Chrome, marque "Allow remote debugging" em chrome://inspect/#remote-debugging)')
src,outdir=os.path.abspath(sys.argv[1]),sys.argv[2]
if not os.path.isfile(src): sys.exit('arquivo não existe: '+src)
os.makedirs(outdir,exist_ok=True)
t=post('cdp',{'method':'Target.createTarget','params':{'url':'about:blank','background':True}})['result']['targetId']
try:
  post('cdp',{'target':t,'method':'Emulation.setDeviceMetricsOverride','params':{'width':1920,'height':540,'deviceScaleFactor':2,'mobile':False}})
  post('cdp',{'target':t,'method':'Page.navigate','params':{'url':'file://'+src}})
  time.sleep(4); post('eval',{'target':t,'expr':"document.fonts.ready.then(()=>1)"})
  n=post('eval',{'target':t,'expr':"document.querySelectorAll('.slide').length"})['value']
  for i in range(n):
    y=post('eval',{'target':t,'expr':f"document.querySelectorAll('.slide')[{i}].getBoundingClientRect().top+scrollY"})['value']
    s=post('cdp',{'target':t,'method':'Page.captureScreenshot','params':{'format':'png','captureBeyondViewport':True,'clip':{'x':0,'y':y,'width':1920,'height':540,'scale':1}}})
    open(f'{outdir}/s{i+1:02d}.png','wb').write(base64.b64decode(s['result']['data']))
  print('ok',n)
finally:
  post('cdp',{'method':'Target.closeTarget','params':{'targetId':t}})
