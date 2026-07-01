# 🌳 Aile Ağacı

Docker Compose ile tek komutta ayağa kalkan, **PostgreSQL veritabanı + web arayüzü**nden oluşan basit bir aile ağacı yönetim uygulaması.

- **GEDCOM içe aktarma** — MyHeritage vb. araçlardan aldığınız `.ged` dosyasını yükleyin.
- **Kişi yönetimi** — birey ekleme/çıkarma, detay düzenleme (doğum/ölüm/meslek/notlar).
- **İlişkiler** — ebeveyn, eş ve çocuk bağlarını kurma.
- **Görseller** — her kişiye fotoğraf yükleme.
- **Soyağacı görselleştirme** — seçilen kişinin atalarını d3.js ile çizim.
- **Yetkilendirme** — kullanıcılara *görüntüleyici / düzenleyici / yönetici* rolleri.
- **GEDCOM dışa aktarma** — ağacı tekrar `.ged` olarak indirin.

## Teknoloji

| Katman | Seçim |
|--------|-------|
| Backend | Python 3.12 · FastAPI · SQLAlchemy |
| Veritabanı | PostgreSQL 16 |
| Frontend | Vanilla JS SPA + d3.js (statik olarak sunulur) |
| Çalışma | Docker Compose (2 servis: `db`, `web`) |

## Hızlı Başlangıç

```bash
cp .env.example .env      # değerleri (özellikle SECRET_KEY / ADMIN_PASSWORD) düzenleyin
docker compose up --build
```

Ardından tarayıcıdan: **http://localhost:8080**

İlk açılışta `.env` içindeki bilgilerle bir **yönetici** hesabı oluşturulur:

- E-posta: `ADMIN_EMAIL` (varsayılan `admin@example.com`)
- Parola: `ADMIN_PASSWORD` (varsayılan `admin1234`)

> İlk girişten sonra parolayı değiştirin ve `.env` içindeki `SECRET_KEY` değerini uzun rastgele bir dizeyle değiştirin.

## Kullanım

1. **Giriş yapın** (yönetici hesabı).
2. **İçe Aktar** sekmesinden `sample/ornek.ged` (veya kendi MyHeritage dışa aktarımınızı) yükleyin.
3. **Kişiler** sekmesinde bireyleri görüntüleyin, düzenleyin, görsel ekleyin, ilişki kurun.
4. **Ağaç** sekmesinde bir kök kişi seçip soyağacını görselleştirin.
5. **Kullanıcılar** sekmesinden (yönetici) başkalarına görüntüleme/düzenleme yetkisi verin.

### Roller

| Rol | Yetki |
|-----|-------|
| `viewer` (Görüntüleyici) | Yalnızca okuma |
| `editor` (Düzenleyici) | Kişi/ilişki/görsel ekleme-düzenleme, GEDCOM içe aktarma |
| `admin` (Yönetici) | Yukarıdakiler + kullanıcı yönetimi |

## Ortam Değişkenleri

`.env.example` dosyasına bakın. Öne çıkanlar:

| Değişken | Açıklama |
|----------|----------|
| `WEB_PORT` | Web arayüzünün yerel portu (varsayılan `8080`) |
| `SECRET_KEY` | JWT imzalama anahtarı — **mutlaka değiştirin** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | İlk açılışta oluşturulan yönetici |
| `POSTGRES_*` | Veritabanı kimlik bilgileri |

## Veri Kalıcılığı

- Veritabanı → `db_data` adlı Docker volume.
- Yüklenen görseller → `uploads` adlı Docker volume.

Sıfırlamak için: `docker compose down -v` (⚠️ tüm veriyi siler).

## API

Etkileşimli API dokümanı: **http://localhost:8080/docs** (FastAPI otomatik oluşturur).

## Proje Yapısı

```
aile-agaci/
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py          # FastAPI uygulaması, başlangıç, statik sunum
│       ├── config.py        # ortam ayarları
│       ├── database.py      # SQLAlchemy engine/session
│       ├── models.py        # User, Individual, ParentChild, Spouse, Media
│       ├── schemas.py       # Pydantic şemaları
│       ├── security.py      # parola hash + JWT + rol kontrolleri
│       ├── gedcom.py        # GEDCOM parser
│       ├── routers/         # auth, users, individuals, gedcom
│       └── static/          # SPA (index.html, app.js, style.css)
└── sample/
    └── ornek.ged            # kurgusal örnek GEDCOM
```

## Not

Bu proje, `cdn.com.tr` yönetim portalının **"GitHub'dan kur"** özelliğini test etmek için hazırlanmış örnek bir Docker Compose uygulamasıdır.
