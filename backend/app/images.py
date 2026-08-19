"""Yüklenen görsellerden küçük (thumbnail) sürüm üretimi.

Ağaç kartlarındaki avatar 32px, galeri 110px, anasayfa ızgarası 96px — hepsi
şimdiye kadar 10MB'a kadar çıkabilen ORİJİNAL dosyayı indiriyordu. Çok kişili
ağaçta bu yüzlerce megabayt demek. Yükleme sırasında bir kez kare kırpılmış,
WEBP küçük sürüm üretip her yerde onu sunuyoruz; orijinal dosyaya dokunulmuyor
(tam boy görüntüleme ve ileride farklı boyut üretmek için duruyor).
"""
import os

from PIL import Image, ImageOps

THUMB_SIZE = 256  # 32/96/110px gösterimlerin 2x'ini rahat karşılar
THUMB_SUFFIX = "_t.webp"


def thumb_name(filename: str) -> str:
    """abc123.jpg -> abc123_t.webp"""
    return os.path.splitext(filename)[0] + THUMB_SUFFIX


def make_thumbnail(upload_dir: str, filename: str, size: int = THUMB_SIZE) -> str:
    """Orijinalden kare küçük sürüm üretir, dosya adını döndürür.

    Üretilemezse (bozuk dosya, desteklenmeyen biçim) boş string döner —
    çağıran taraf orijinale düşer. Idempotent: dosya varsa yeniden üretmez.
    """
    src = os.path.join(upload_dir, filename)
    if not os.path.isfile(src):
        return ""
    out_name = thumb_name(filename)
    dst = os.path.join(upload_dir, out_name)
    if os.path.isfile(dst):
        return out_name
    # Aynı volume'e birden fazla pod yazabiliyor (rolling deploy + preprod aynı
    # PVC'yi mount ediyor). Geçici dosyaya yazıp atomik rename ile yerine koy:
    # yarım yazılmış bir webp asla servis edilmesin.
    tmp = f"{dst}.{os.getpid()}.tmp"
    try:
        with Image.open(src) as im:
            # Telefon fotoğraflarındaki EXIF döndürme bilgisini piksele uygula.
            im = ImageOps.exif_transpose(im)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGB")
            # CSS tarafında object-fit: cover kullanılıyor; aynı kırpmayı
            # burada yapıyoruz ki kare kutuda hep yüz ortada kalsın.
            im = ImageOps.fit(im, (size, size), method=Image.LANCZOS, centering=(0.5, 0.35))
            im.save(tmp, "WEBP", quality=80, method=4)
        os.replace(tmp, dst)
        return out_name
    except Exception:  # bozuk/desteklenmeyen dosya — orijinale düşülür
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return ""
