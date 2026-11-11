FROM docker.io/library/python:3.12-slim
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn==0.34.0 python-multipart==0.0.20
WORKDIR /srv
COPY app.py login.html ./
ENV PYTHONUNBUFFERED=1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--no-access-log"]
