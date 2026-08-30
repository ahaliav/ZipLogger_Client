FROM python:3.12-slim

WORKDIR /app

# Installed from PyPI, exactly as a customer would.
RUN pip install --no-cache-dir ziplogger==0.4.0

COPY app.py .

# Unbuffered so container logs appear immediately in `docker logs`.
ENV PYTHONUNBUFFERED=1

CMD ["python", "app.py"]
