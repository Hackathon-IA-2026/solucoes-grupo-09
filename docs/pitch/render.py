import json,urllib.request,time,base64,sys,os
def post(p,b):
    r=urllib.request.Request('http://127.0.0.1:9333/'+p,data=json.dumps(b).encode(),headers={'content-type':'application/json'})
    try:
        return json.loads(urllib.request.urlopen(r,timeout=180).read().decode())
    except urllib.error.URLError:
        raise SystemExit('daemon cdpd fora do ar em 127.0.0.1:9333.\nSuba com: node tools/cdpd.mjs &   (e, no Chrome, marque "Allow remote debugging" em chrome://inspect/#remote-debugging)')
src,pdf=os.path.abspath(sys.argv[1]),sys.argv[2]
t=post('cdp',{'method':'Target.createTarget','params':{'url':'about:blank','background':True}})['result']['targetId']
try:
  post('cdp',{'target':t,'method':'Emulation.setDeviceMetricsOverride','params':{'width':1440,'height':810,'deviceScaleFactor':1,'mobile':False}})
  post('cdp',{'target':t,'method':'Page.navigate','params':{'url':'file://'+src}})
  time.sleep(4); post('eval',{'target':t,'expr':"document.fonts.ready.then(()=>1)"})
  r=post('cdp',{'target':t,'method':'Page.printToPDF','params':{'printBackground':True,'preferCSSPageSize':True}})
  open(pdf,'wb').write(base64.b64decode(r['result']['data'])); print('pdf ok')
finally:
  post('cdp',{'method':'Target.closeTarget','params':{'targetId':t}})
