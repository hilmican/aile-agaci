# MyHeritage DNA eşleşme crawler'ları

Girişli bir Chrome'u (CDP, `--remote-debugging-port=9222`) kullanarak MyHeritage DNA
eşleşmelerini Aile Ağacı uygulamasına aktarır. Çerez/şifre çalınmaz — kullanıcının
zaten açık oturumu üzerinden çalışır. `websocket-client` gerekir (`pip install websocket-client`).

## Ön koşul: girişli Chrome'u CDP ile aç
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/path/to/profile
# Aç: https://www.myheritage.com.tr/dna/matches/<KIT>  (giriş yapılmış olmalı)
```

Ortam: `AILE_BASE` (varsayılan http://localhost:8100; prod https://aileagaci.hilmibaycan.com),
`AILE_EMAIL`, `AILE_PASS`.

## 1) Tam liste (hızlı, API'den)
`fetch_dna_matches_for_kit` GraphQL ucunu offset ile sayfalayıp TÜM eşleşmeleri (isim,
cM, akrabalık, ağaç, yönetici) çeker. Guid ile tekilleştirir.
```bash
python3 dna_list_crawler.py --base https://aileagaci.hilmibaycan.com
```

## 2) Detaylar (tek tek, cM sırasıyla)
Her eşleşmenin detay sayfasını açıp tüm GraphQL uçlarını + TAM ortak-eşleşme listesini
(offset sayfalama) çeker. `next-undetailed` en yüksek cM'den ilerler.
```bash
python3 dna_detail_crawler.py --base https://aileagaci.hilmibaycan.com --count 100 --delay 2
```

### Görüntüleme limiti (ÖNEMLİ)
MyHeritage, çok sayıda eşleşme detayı görüntülenince **ortak-eşleşme (in-common) ucunu
bloklar** — detay yine gelir ama `dna_shared_matches` boş döner ("YAKALANAMADI"). Bu kayıtlar
kümelemeye katkısız kalır. Crawler `--stop-on-empty N` (varsayılan 8) ile ard arda N boş
gelince **kendini durdurur**. Limit birkaç gün içinde sıfırlanır.

### Limit açılınca devam (resume)
```bash
# a) Limit döneminde boş kaydedilmiş ortak-listeleri düzelt:
python3 dna_detail_crawler.py --base <BASE> --recrawl-empty --delay 2
# b) Kalan detaysızlara devam et (cM sırası):
python3 dna_detail_crawler.py --base <BASE> --count 500 --delay 2
```

`--recrawl` : mevcut TÜM detaylıları yeniden çeker (ör. tam ortak-liste eklendiğinde).
`--ids 1,2` : belirli id'leri (yeniden) çeker.

## Durum (2026-07-13)
- 1532 eşleşmenin tamamı listede. **272 detaylı**; bunların **~210'u tam ortak-listeli**
  (batch-1+2). Son ~62 kayıt görüntüleme limiti nedeniyle **boş ortak-listeli**.
- Kümeleme: 187'si tek **baba** kümesi, **anne tarafı yok/görünmüyor**, gerisi tekil ada.
- Devam: yukarıdaki resume adımları. Backend uçları: `/api/dna/graph`, `/{id}/analysis`,
  `/{id}/side` (manuel taraf tohumu), `/next-undetailed`.
