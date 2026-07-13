#!/usr/bin/env python3
"""MyHeritage DNA eşleşmelerini (girişli CDP Chrome'dan) çekip Aile Ağacı
uygulamasına aktarır. Yavaş/az; --pages ile sayfa sayısı (varsayılan 1)."""
import argparse, json, os, time, urllib.parse, urllib.request, websocket

EXTRACT = r"""(() => {
  const cards=[...document.querySelectorAll('.card_row.match_details')];
  const dlinks=[...document.querySelectorAll('a')].filter(a=>/incele/i.test(a.innerText||'')).map(a=>a.href);
  return cards.map((card,ci)=>{
    const q=sel=>{const e=card.querySelector(sel);return e?e.innerText.replace(/\s+/g,' ').trim():"";};
    const t=card.innerText||"";
    const pm=t.match(/([\d.,]+)\s*%\s*\(([\d.,]+)\s*[‎\s]*cM\)/);
    const seg=t.match(/Payla[^\n]*DNA\s*([\d.,]+)/);
    const lg=t.match(/([\d.,]+)\s*[‎\s]*cM\s*En b[^\n]*par/);
    const photo=card.querySelector("[class*='gender_']");
    return {
      name:q("[data-automations='ProfileNameCallout']")||q("[data-automations='ProfileDetailsName']"),
      manager:q("[data-automations='KitManagedBy']"),
      relationship:q("[data-automations='EstimatedRelationships']"),
      match_quality_pct:pm?pm[1]:"", shared_cm:pm?pm[2]:"",
      shared_segments:seg?seg[1]:"", largest_segment_cm:lg?lg[1]:"",
      age:(t.match(/Ya[şs]:\s*([^\n]+)/)||[])[1]||"",
      country:(t.match(/[ÜU]lke:\s*([^\n]+)/)||[])[1]||"",
      smart_matches:(t.match(/(\d+)\s*adet Smart/)||[])[1]||"",
      tree_size:(t.match(/(\d+)\s*adet ki[şs]iden/)||[])[1]||"",
      gender_class:photo?photo.className:"", raw_text:t.slice(0,700),
      detail_href:dlinks[ci]||""
    };
  });
})()"""

def cdp():
    tabs=json.load(urllib.request.urlopen("http://localhost:9222/json"))
    page=next(t for t in tabs if t["type"]=="page" and "myheritage" in t["url"])
    ws=websocket.create_connection(page["webSocketDebuggerUrl"], max_size=None, suppress_origin=True)
    return ws, page["url"]

_mid=[0]
def ev(ws, expr):
    _mid[0]+=1; i=_mid[0]
    ws.send(json.dumps({"id":i,"method":"Runtime.evaluate","params":{"expression":expr,"returnByValue":True,"awaitPromise":True}}))
    ws.settimeout(20)
    while True:
        m=json.loads(ws.recv())
        if m.get("id")==i: return m.get("result",{}).get("result",{}).get("value")

def api(base, path, method="GET", data=None, token=None, form=False):
    h={}
    if token: h["Authorization"]="Bearer "+token
    body=None
    if form: body=data.encode(); h["Content-Type"]="application/x-www-form-urlencoded"
    elif data is not None: body=json.dumps(data).encode(); h["Content-Type"]="application/json"
    with urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers=h,method=method)) as x:
        r=x.read(); return json.loads(r) if r else None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("AILE_BASE","http://localhost:8100"))
    ap.add_argument("--email", default=os.environ.get("AILE_EMAIL","admin@example.com"))
    ap.add_argument("--password", default=os.environ.get("AILE_PASS","admin1234"))
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--delay", type=float, default=2.5)
    a=ap.parse_args()
    ws,url=cdp()
    kit=url.rstrip("/").split("/dna/matches/")[-1].split("#")[0].split("?")[0]
    tok=api(a.base,"/api/auth/login","POST",f"username={urllib.parse.quote(a.email)}&password={urllib.parse.quote(a.password)}",form=True)["access_token"]
    grand=0
    for p in range(a.pages):
        matches=ev(ws, EXTRACT) or []
        for mm in matches:
            h=mm.get('detail_href','')
            if '/dna/match/' in h:
                seg=h.split('/dna/match/')[1].split('/')[0]
                mm['match_guid']=seg
        first=matches[0]["name"] if matches else ""
        r=api(a.base,"/api/dna/import","POST",{"kit":kit,"matches":matches},token=tok)
        grand+=len(matches)
        print(f"Sayfa {p+1}: {len(matches)} eşleşme çekildi/aktarıldı (ilk: {first}) → app toplam {r['total']}")
        if p < a.pages-1:
            # 'Sonraki' oku = pagination'ın son öğesi (metinsiz)
            ok=ev(ws, r"""(()=>{const it=[...document.querySelectorAll('.pagination_item')];
              const nxt=it[it.length-1]; if(nxt){nxt.click();return true;} return false;})()""")
            if not ok: print("Sonraki sayfa bulunamadı, durdum."); break
            # ilk eşleşme adı değişene dek bekle
            for _ in range(16):
                time.sleep(a.delay/8)
                nm=ev(ws, "(()=>{const c=document.querySelector('.card_row.match_details');return c?c.innerText.split('\\n')[0]:'';})()")
                if nm and nm!=first: break
            time.sleep(a.delay)
    print(f"BİTTİ: bu koşuda {grand} eşleşme işlendi. Uygulamada DNA sekmesinde görünür.")
    ws.close()

if __name__=="__main__": main()
