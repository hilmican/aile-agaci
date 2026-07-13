#!/usr/bin/env python3
"""TAM DNA eşleşme listesini API'den çeker: MyHeritage 'fetch_dna_matches_for_kit'
GraphQL ucunu (girişli CDP Chrome'da yakalanan istek) offset ile sayfalayıp tüm
~1500 eşleşmeyi zengin veriyle (cM, segment, olasılıklı akrabalık+MRCA sınıfı,
ağaç, yönetici) alır ve app'e aktarır. DOM kazımaktan hızlı/zengin.
Kayıtların tamamı raw'da saklanır; guid ile tekilleştirilir."""
import argparse, base64, json, os, re, time, urllib.parse, urllib.request, websocket

LIST_URL_DEFAULT="https://www.myheritage.com.tr/dna/matches/OYYV6HQ2C4IWB4JDYGWWDSJIURXMKYQ"

def api(base, path, method="GET", data=None, token=None, form=False):
    h={}
    if token: h["Authorization"]="Bearer "+token
    body=None
    if form: body=data.encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    elif data is not None: body=json.dumps(data).encode(); h["Content-Type"]="application/json"
    with urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers=h,method=method)) as x:
        r=x.read(); return json.loads(r) if r else None

_id=[0]
def send(ws,m,p=None): _id[0]+=1; ws.send(json.dumps({"id":_id[0],"method":m,"params":p or {}})); return _id[0]
def res(ws,i):
    ws.settimeout(60)
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==i: return m.get("result",{})
def ev(ws,expr): return res(ws,send(ws,"Runtime.evaluate",{"expression":expr,"returnByValue":True,"awaitPromise":True})).get("result",{}).get("value")

def dig(o,*p):
    for k in p:
        o=o.get(k) if isinstance(o,dict) else None
        if o is None: return None
    return o

def fmt_tr(x):
    """1680.35 -> '1.680,35' (TR görüntü)."""
    if x is None: return ""
    s=f"{float(x):,.2f}".rstrip("0").rstrip(".")
    return s.replace(",","·").replace(".",",").replace("·",".")

def transform(rec):
    ai=dig(rec,"other_dna_kit","associated_individual") or {}
    sub=dig(rec,"other_dna_kit","submitter") or {}
    name=ai.get("name") or sub.get("name") or ""
    rel=(rec.get("refined_dna_relationships") or rec.get("complete_dna_relationships") or [{}])
    relstr=rel[0].get("relationship_degree","") if rel else ""
    cm=rec.get("total_shared_segments_length_in_cm")
    return {
        "name":name,
        "manager":(sub.get("name") or "") if (sub.get("name") and sub.get("name")!=name) else "",
        "relationship":relstr,
        "match_quality_pct":str(rec.get("percentage_of_shared_segments") or ""),
        "shared_cm":fmt_tr(cm), "shared_cm_val":cm,
        "shared_segments":str(rec.get("total_shared_segments") or ""),
        "largest_segment_cm":fmt_tr(rec.get("largest_shared_segment_length_in_cm")),
        "age":ai.get("age_group") or "",
        "country":dig(ai,"tree","site","creator","country") or "",
        "tree_size":str(dig(ai,"tree","individual_count") or ""),
        "gender":ai.get("gender") or "",
        "match_guid":(rec.get("id") or "").replace("dnamatch-",""),
        "detail_href":rec.get("link") or "",
        "raw":rec,
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("AILE_BASE","http://localhost:8100"))
    ap.add_argument("--email", default=os.environ.get("AILE_EMAIL","admin@example.com"))
    ap.add_argument("--password", default=os.environ.get("AILE_PASS","admin1234"))
    ap.add_argument("--list-url", default=LIST_URL_DEFAULT)
    ap.add_argument("--batch-pages", type=int, default=25, help="tek JS çağrısında kaç sayfa (×10 kayıt)")
    ap.add_argument("--max", type=int, default=100000)
    a=ap.parse_args()
    tok=api(a.base,"/api/auth/login","POST",f"username={urllib.parse.quote(a.email)}&password={urllib.parse.quote(a.password)}",form=True)["access_token"]
    kit=a.list_url.rstrip("/").split("/dna/matches/")[-1].split("#")[0].split("?")[0]

    tabs=json.load(urllib.request.urlopen("http://localhost:9222/json"))
    page=next(t for t in tabs if t["type"]=="page" and "myheritage" in t["url"])
    ws=websocket.create_connection(page["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)
    send(ws,"Network.enable"); send(ws,"Page.enable")
    send(ws,"Storage.clearDataForOrigin",{"origin":"https://www.myheritage.com.tr","storageTypes":"cache_storage,indexeddb"})
    send(ws,"Page.navigate",{"url":a.list_url})
    post=None; end=time.time()+16; ws.settimeout(1.0)
    while time.time()<end:
        try: msg=json.loads(ws.recv())
        except Exception: continue
        if msg.get("method")=="Network.requestWillBeSent":
            r=msg["params"]["request"]
            if "fetch_dna_matches_for_kit" in r["url"] and r.get("postData") and not post: post=r["postData"]
    if not post: print("Liste isteği yakalanamadı"); return
    b=post.splitlines()[0].strip(); fields={}
    for p in post.split(b):
        m=re.search(r'name="([^"]+)"\r?\n\r?\n(.*)', p, re.S)
        if m: fields[m.group(1)]=m.group(2).rstrip("\r\n-")

    # offset ile toplu sayfalama (in-page fetch)
    def fetch_batch(start, pages):
        js='''(async()=>{
          const F=%s, start=%d, pages=%d;
          const find=(o,k)=>{ if(o&&typeof o==="object"){ if(k in o) return o[k]; for(const v of Object.values(o)){const r=find(v,k); if(r!=null) return r;} } return null; };
          const call=async(off)=>{ const q=F.query.replace(/offset:\\d+/, "offset:"+off); const P=Object.assign({},F); P.query=q;
            const fd=new FormData(); for(const k in P) fd.append(k,P[k]);
            const r=await fetch("/web-family-graphql/fetch_dna_matches_for_kit/",{method:"POST",body:fd});
            const j=await r.json(); const dm=find(j,"dna_matches"); return (dm&&dm.data)||[]; };
          let all=[];
          for(let i=0;i<pages;i++){ const d=await call(start+i*10); all=all.concat(d); if(d.length<10) break; }
          return JSON.stringify(all);
        })()''' % (json.dumps(fields), start, pages)
        return json.loads(ev(ws, js) or "[]")

    off=0; grand=0; total=0
    while off < a.max:
        recs=fetch_batch(off, a.batch_pages)
        if not recs: break
        matches=[transform(r) for r in recs if (r.get("id"))]
        r=api(a.base,"/api/dna/import","POST",{"kit":kit,"matches":matches},token=tok)
        total=r["total"]; grand+=len(matches)
        print(f"offset {off:>5}: +{len(matches)} çekildi/aktarıldı → app toplam {total}", flush=True)
        if len(recs) < a.batch_pages*10: break
        off += a.batch_pages*10
        time.sleep(0.4)
    print(f"BİTTİ: bu koşuda {grand} kayıt işlendi. App toplam {total}.")
    ws.close()

if __name__=="__main__": main()
