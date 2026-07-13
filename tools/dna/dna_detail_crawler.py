#!/usr/bin/env python3
"""Bir DNA eşleşmesinin detay sayfasını (girişli CDP Chrome'da) açıp tüm
GraphQL detay verilerini (segmentler, ortak eşleşmeler, soyad/mekân, ToFR,
notlar) + DOM'daki akrabalık olasılıkları/MRCA'yı çeker ve app'e kaydeder.

TAM ortak-eşleşme listesi: MyHeritage shared_matches ucunu server limit'i 10'da
sabitliyor ama offset ile sayfalanıyor -> yakalanan isteği (bearer_token+query)
in-page fetch ile offset 0,10,20… diye çağırıp tüm listeyi (300-500 kişi) toplar.

Modlar:
  (varsayılan) --count N   : next-undetailed döngüsü (yeni, detaysızları çeker)
  --recrawl                : mevcut TÜM eşleşmeleri yeniden çeker (tam ortak-eşleşme için)
  --ids 1,2,3              : sadece bu id'leri (yeniden) çeker
"""
import argparse, base64, json, os, time, urllib.parse, urllib.request, websocket, re

def api(base, path, method="GET", data=None, token=None, form=False):
    h={}
    if token: h["Authorization"]="Bearer "+token
    body=None
    if form: body=data.encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    elif data is not None: body=json.dumps(data).encode(); h["Content-Type"]="application/json"
    with urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers=h,method=method)) as x:
        r=x.read(); return json.loads(r) if r else None

def conn():
    tabs=json.load(urllib.request.urlopen("http://localhost:9222/json"))
    page=next(t for t in tabs if t["type"]=="page" and "myheritage" in t["url"])
    return websocket.create_connection(page["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)

_id=[0]
def send(ws,m,p=None):
    _id[0]+=1; ws.send(json.dumps({"id":_id[0],"method":m,"params":p or {}})); return _id[0]
def result(ws,i):
    ws.settimeout(30)
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==i: return m.get("result",{})
def ev(ws,expr):
    return result(ws, send(ws,"Runtime.evaluate",{"expression":expr,"returnByValue":True,"awaitPromise":True})).get("result",{}).get("value")

DOM_EXTRACT = r"""(()=>{
  const secText = h => { const el=[...document.querySelectorAll('h1,h2,h3,h4')].find(e=>new RegExp(h,'i').test(e.innerText||'')); return el?el.parentElement.innerText.slice(0,1200):''; };
  return {
    probable_relationships: secText('Olasıl|akrabal'),
    shared_matches_line: (document.body.innerText.match(/([\d.]+)\s*DNA E[şs]le[şs]mesini payla/)||[])[0]||'',
    shared_surnames: secText('ortak.*soyad|Payla[şs][ıi]lan soyad'),
    shared_places: secText('ortak.*mek[âa]n|Payla[şs][ıi]lan yer'),
    full_text: (document.body.innerText||'').slice(0,4000)
  };
})()"""

def _fields_from_post(post):
    """multipart postData -> {alan: değer} sözlüğü."""
    b=post.splitlines()[0].strip(); fields={}
    for p in post.split(b):
        m=re.search(r'name="([^"]+)"\r?\n\r?\n(.*)', p, re.S)
        if m: fields[m.group(1)]=m.group(2).rstrip("\r\n-")
    return fields

def _full_shared_matches(ws, fields):
    """Yakalanan shared_matches isteğini offset ile sayfalayıp tüm listeyi toplar.
    endpoints için tam GraphQL cevabı şeklinde döndürür."""
    js='''(async()=>{
      const F=%s;
      const build=(off)=>{const g=F.query.replace(/offset:\\d+/, "offset:"+off); const o=Object.assign({},F); o.query=g; return o;};
      const call=async(off)=>{const P=build(off); const fd=new FormData(); for(const k in P) fd.append(k,P[k]);
        const r=await fetch("/web-family-graphql/dna_single_match_get_shared_matches/",{method:"POST",body:fd});
        return (await r.json()).data.dna_match.dna_shared_matches;};
      const first=await call(0); const count=first.count; let all=first.data.slice();
      for(let off=10; off<count && off<2000; off+=10){ const s=await call(off); if(!s.data.length) break; all=all.concat(s.data); }
      return JSON.stringify({count:count, data:all});
    })()''' % json.dumps(fields)
    out=ev(ws, js)
    try:
        obj=json.loads(out)
        return {"data":{"dna_match":{"dna_shared_matches":{"count":obj["count"],"data":obj["data"]}}}}, obj["count"], len(obj["data"])
    except Exception:
        return None, 0, 0

def capture_detail(ws, url, seconds=9):
    send(ws,"Network.enable"); send(ws,"Page.enable")
    send(ws,"Network.setCacheDisabled",{"cacheDisabled":True})
    send(ws,"Storage.clearDataForOrigin",{"origin":"https://www.myheritage.com.tr","storageTypes":"cache_storage,indexeddb,service_workers,websql"})
    send(ws,"Network.clearBrowserCache")
    time.sleep(0.5)
    send(ws,"Page.navigate",{"url":url})
    resp={}; shared_fields=[None]; ws.settimeout(1.0)
    def pump(u):
        while time.time()<u:
            try: msg=json.loads(ws.recv())
            except Exception: continue
            meth=msg.get("method")
            if meth=="Network.requestWillBeSent":
                r=msg["params"]["request"]
                if "shared_matches" in r["url"] and r.get("postData") and shared_fields[0] is None:
                    shared_fields[0]=_fields_from_post(r["postData"])
            elif meth=="Network.responseReceived":
                p=msg["params"]; r=p["response"]
                if p.get("type") in ("XHR","Fetch") and "web-family-graphql" in r["url"]:
                    resp[p["requestId"]]=r["url"]
    pump(time.time()+seconds)
    for i in range(16):
        send(ws,"Runtime.evaluate",{"expression":f"window.scrollTo(0,{(i+1)*500})"}); pump(time.time()+1.1)
    pump(time.time()+3)
    endpoints={}
    for rid,url2 in resp.items():
        gid=send(ws,"Network.getResponseBody",{"requestId":rid}); res=result(ws,gid)
        body=base64.b64decode(res["body"]).decode("utf-8","replace") if res.get("base64Encoded") else res.get("body","")
        key=url2.split("web-family-graphql/")[-1].split("/")[0].split("?")[0]
        try: endpoints[key]=json.loads(body)
        except Exception: endpoints[key]=body[:20000]
    # TAM ortak-eşleşme listesi
    shared_total=None
    if shared_fields[0]:
        full,total,got=_full_shared_matches(ws, shared_fields[0])
        if full:
            endpoints["dna_single_match_get_shared_matches"]=full
            shared_total=(got,total)
    dom=ev(ws, DOM_EXTRACT)
    return {"endpoints":endpoints, "dom":dom, "captured_at":time.strftime("%Y-%m-%dT%H:%M:%S")}, shared_total

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("AILE_BASE","http://localhost:8100"))
    ap.add_argument("--email", default=os.environ.get("AILE_EMAIL","admin@example.com"))
    ap.add_argument("--password", default=os.environ.get("AILE_PASS","admin1234"))
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--delay", type=float, default=3.0)
    ap.add_argument("--recrawl", action="store_true", help="mevcut TÜM eşleşmeleri yeniden çek")
    ap.add_argument("--recrawl-empty", dest="recrawl_empty", action="store_true",
                    help="detaylı ama ortak-listesi BOŞ kayıtları yeniden çek (limit sonrası)")
    ap.add_argument("--ids", default="", help="virgüllü id listesi")
    ap.add_argument("--stop-on-empty", dest="stop_on_empty", type=int, default=8,
                    help="ard arda bu kadar boş ortak-liste gelince dur (görüntüleme limiti işareti); 0=kapalı")
    a=ap.parse_args()
    tok=api(a.base,"/api/auth/login","POST",f"username={urllib.parse.quote(a.email)}&password={urllib.parse.quote(a.password)}",form=True)["access_token"]
    ws=conn()

    targets=[]
    if a.ids:
        for i in [int(x) for x in a.ids.split(",") if x.strip()]:
            m=api(a.base,f"/api/dna/{i}",token=tok); targets.append((m["match_guid"],m["detail_url"],m["name"]))
    elif a.recrawl or a.recrawl_empty:
        items=api(a.base,"/api/dna?limit=100000",token=tok)["items"]
        for it in items:
            if not it.get("has_detail"): continue
            m=api(a.base,f"/api/dna/{it['id']}",token=tok)
            if not m.get("detail_url"): continue
            if a.recrawl_empty:  # yalnız ortak-listesi boş olanları hedefle
                eps=(m.get("detail") or {}).get("endpoints",{}) if isinstance(m.get("detail"),dict) else {}
                sm=(((eps.get("dna_single_match_get_shared_matches") or {}).get("data") or {}).get("dna_match") or {}).get("dna_shared_matches") or {}
                if (sm.get("data") or []): continue  # zaten dolu, atla
            targets.append((m["match_guid"],m["detail_url"],m["name"]))
        print(f"{len(targets)} hedef ({'boş ortak-listeli' if a.recrawl_empty else 'tümü'}).", flush=True)

    done=[0]; empty_streak=[0]; stopped=[False]
    def process(guid,url,name):
        print(f"→ {name} detayı çekiliyor…", flush=True)
        detail,shared=capture_detail(ws, url)
        got = bool(shared and shared[0])
        eps=list(detail["endpoints"].keys())
        api(a.base,"/api/dna/detail","POST",{"match_guid":guid,"detail":detail,"detail_url":url},token=tok)
        st=f" | ortak-eşleşme {shared[0]}/{shared[1]}" if shared else " | ortak-eşleşme YAKALANAMADI"
        print(f"   kaydedildi. Uçlar: {len(eps)}{st}", flush=True)
        done[0]+=1
        empty_streak[0] = 0 if got else empty_streak[0]+1
        if a.stop_on_empty and empty_streak[0] >= a.stop_on_empty:
            print(f"\n⚠ {empty_streak[0]} ard arda boş ortak-liste — görüntüleme limiti olası. Durduruluyor.\n"
                  f"  Limit açılınca: python3 dna_detail_crawler.py --recrawl-empty ... (boşları düzelt) sonra --count ile devam.", flush=True)
            stopped[0]=True
        time.sleep(a.delay)

    if targets:
        for guid,url,name in targets:
            if stopped[0]: break
            try: process(guid,url,name)
            except Exception as e: print(f"   HATA {name}: {e}", flush=True)
    else:
        for _ in range(a.count):
            if stopped[0]: break
            nx=api(a.base,"/api/dna/next-undetailed",token=tok)
            if nx.get("done"): print("Detayı çekilecek eşleşme kalmadı."); break
            try: process(nx["match_guid"],nx["detail_url"],nx["name"])
            except Exception as e: print(f"   HATA {nx['name']}: {e}", flush=True)
    print(f"BİTTİ: {done[0]} eşleşme detayı çekildi.")
    ws.close()

if __name__=="__main__": main()
