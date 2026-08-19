# CLAUDE.md

Aile Ağacı — Baycan ailesi soyağacı uygulaması. Docker Compose ile ayağa kalkan
FastAPI + PostgreSQL backend ve statik olarak sunulan vanilla-JS SPA. Ayrıca
MyHeritage DNA eşleşmelerini içe aktaran crawler scriptleri (`tools/dna/`).

> Bu depodaki kod, yorumlar, commit mesajları ve arayüz **Türkçe**dir.
> Yeni kod yazarken aynı dili ve üsluba uyun (yorumlar Türkçe, kısa ve "neden"i
> anlatan cinsten). Commit mesajları `feat:` / `fix:` / `tweak:` / `chore:` +
> Türkçe açıklama biçiminde.

## Çalıştırma

```bash
cp .env.example .env          # SECRET_KEY / ADMIN_PASSWORD mutlaka değiştirin
docker compose up --build     # http://localhost:8080  (API dokümanı: /docs)
```

Geliştirme sırasında yaygın döngü (bkz. `.claude/settings.local.json`):

```bash
node --check backend/app/static/app.js                  # SPA sözdizimi kontrolü
WEB_PORT=8100 docker compose up -d --build web          # sadece web'i yeniden kur
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8100/
```

Otomatik test yok; doğrulama elle yapılır — konteyneri kaldırıp ilgili
endpoint'i `curl` ile veya arayüzden denemek beklenen akıştır. Yalnızca frontend
değiştiyse `node --check` + sayfayı yenilemek yeterlidir.

Prod: `https://aileagaci.hilmibaycan.com`.

## Mimari

```
backend/app/
  main.py        # FastAPI app, startup (şema göçü, admin seed, metin temizliği), SPA sunumu
  config.py      # pydantic-settings; DATABASE_URL normalizasyonu, ALLOW_GEDCOM_IMPORT
  database.py    # engine/SessionLocal/Base, wait_for_db
  models.py      # tüm SQLAlchemy modelleri (tek dosya)
  schemas.py     # Pydantic şemaları
  security.py    # bcrypt + JWT, get_current_user / require_editor / require_admin
  activity.py    # log_activity — anasayfa haber akışı
  gedcom.py      # GEDCOM parser + clean_text (HTML entity temizliği)
  routers/       # auth, users, individuals, gedcom_router, dashboard,
                 # families, map_router, bulk, dna
  static/        # SPA: index.html + app.js (~2.9k satır) + style.css
tools/dna/       # MyHeritage crawler'ları (CDP üzerinden, bkz. tools/dna/README.md)
```

API uçları `/api/*` altında; SPA en sona mount edilir, bu yüzden API rotaları
önceliklidir. Kişi kayıtları `individuals`; ilişkiler ayrı tablolarda
(`parent_child`, `spouses`). `families` soyaddan bağımsız aile kollarıdır
(Vasiloğulları, Salehler…) ve `individual_families` ile çoklu bağlanır.

### Şema değişiklikleri — Alembic yok

Migration aracı kullanılmıyor. Startup'ta `Base.metadata.create_all` yeni tablo
açar; **mevcut tabloya sütun eklemek için `main.py:ensure_schema()` içindeki
`alters` listesine `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` satırı eklenir.**
Modele sütun ekleyip bu listeyi güncellememek prod'da hataya yol açar. Listedeki
her ifade idempotent ve veri koruyucu olmalı — `DROP` yok.

### Frontend

`static/app.js` tek dosyalık, modülsüz, `"use strict"` bir SPA. Kurallar:

- Tüm istekler `api(path, {json})` yardımcısıyla; 401'de otomatik `logout()`.
- HTML string'e giden her kullanıcı verisi `esc()` ile kaçırılır.
- Sekmeler `data-tab` düğmeleri ↔ `#tab-<ad>` bölümleri; durum `location.hash`
  ile paylaşılabilir (`updateHash` / `applyHash`).
- Tarihler ham GEDCOM biçiminde saklanır, yalnız gösterimde `trDate()` ile
  Türkçeleştirilir (`ABT 1950` → `yakl. 1950`).
- `index.html` her istekte taze döner ve `__BUILD__` yer tutucusu build
  numarasıyla değiştirilir (cache-busting). Yeni statik varlık eklerken URL'ye
  `?v=__BUILD__` eklemeyi unutmayın.
- Kırılgan yerlerde d3.js kullanılır (ağaç, gen ağacı, harita).

### Yetkilendirme

Roller `viewer` / `editor` / `admin`. Yazan her endpoint `require_editor`,
kullanıcı yönetimi `require_admin` bağımlılığını kullanır. İlk açılışta `.env`
bilgileriyle tek yönetici seed edilir.

### GEDCOM içe aktarma

`ALLOW_GEDCOM_IMPORT` **varsayılan kapalı** — ilk kurulumdan sonra yeniden import
mükerrer kayıt üretir. Kapalıyken `/api/gedcom/import` 403 döner; bu kasıtlıdır,
"düzeltmeyin".

## Görseller

Yüklenen dosyalar `settings.upload_dir` (`/data/uploads`) altında UUID adıyla
durur, `/uploads/*` olarak statik sunulur. Prod'da bu dizin **kalıcı bir CephFS
volume**dur (bkz. aşağıdaki dağıtım notu) — konteyner yeniden kurulunca kaybolmaz.

Yükleme sırasında `images.py:make_thumbnail` ile **256px kare WEBP küçük sürüm**
(`<uuid>_t.webp`) üretilir. Ağaç kartları, anasayfa ızgarası ve galeri **daima
küçük sürümü** kullanır; orijinal yalnızca tam boy görüntülemede açılır. Yeni bir
yerde kişi fotoğrafı göstereceksen `individuals.py:person_photo_url()` kullan —
orijinali doğrudan `/uploads/<filename>` diye bağlamak, çok kartlı ağaçta
megabaytlarca gereksiz indirme demektir.

Bir kişinin birden çok görseli olabilir; ağaçta hangisinin kullanılacağı
`individuals.primary_media_id` ile seçilir (galeride ★ düğmesi →
`POST /api/individuals/{id}/media/{media_id}/primary`). Seçim yoksa ilk görsel
kullanılır. Küçük sürümü olmayan eski kayıtlar için `main.py:backfill_thumbnails`
startup'ta arka planda (ayrı thread) üretim yapar; idempotenttir.

## Dağıtım (prod)

`aileagaci.hilmibaycan.com`, cdn.com.tr container-apps platformunda (k8s) çalışır;
deploy Git'ten compose import ile yapılır. Compose'daki `uploads:` adlandırılmış
volume, platformda tek kalıcı mount olarak `/data/uploads`'a bağlanır
(PVC, RWX, `csi-cephfs-retain`). Compose'a **ikinci bir volume eklemeyin** —
platform servis başına yalnız bir kalıcı mount destekler, fazlası uyarıyla düşer.

## DNA katmanı

En aktif geliştirme alanı. `routers/dna.py` (~900 satır) MyHeritage eşleşmelerini
tutar ve üzerine analiz kurar: taraf çıkarımı (label propagation ile kümeleme),
ortak ata (MRCA) tahmini, ağaçla yapısal kesişim, endogami-farkında kol tespiti,
ata önerileri. Önemli noktalar:

- Ham crawler çıktısı `dna_matches.raw` / `detail_json` içinde **hiç kaybolmadan**
  saklanır; sonraki analiz denemeleri buradan beslenir.
- İsim karşılaştırmaları `_norm()` ile Türkçe karakter/parantez normalizasyonundan
  geçer; sayılar TR biçiminde gelir (`_parse_tr_num`: `1.680,4` → `1680.4`).
- Yaygın adlar (Mehmet, Ayşe…) uzak eşleşmelerde false-positive üretir; kesişim
  mantığı ebeveyn adıyla korroborasyon ister — bu korumaları gevşetmeyin.
- Crawler kullanımı, MyHeritage'ın görüntüleme limiti ve resume adımları için
  `tools/dna/README.md`. Crawler kullanıcının zaten açık Chrome oturumunu CDP
  (`--remote-debugging-port=9222`) üzerinden kullanır; kimlik bilgisi saklamaz.

## Genel kurallar

- Sırlar depoya girmez; `.env` gitignore'da.
- Mevcut veriyi silen/ezen işlem önerirken açıkça uyarın (`docker compose down -v`
  tüm veriyi siler).
