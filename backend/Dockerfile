FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Build numarası: CI BUILD_ID verirse onu, vermezse build anının damgasını kullan.
# COPY'den sonra geldiği için kod değiştikçe cache kırılır ve damga yenilenir.
ARG BUILD_ID
RUN echo "${BUILD_ID:-$(date -u +%Y%m%d.%H%M)}" > /app/build_id.txt

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
