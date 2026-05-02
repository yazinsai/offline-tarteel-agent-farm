FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cpulimit \
    ffmpeg \
    git \
    git-lfs \
    openssh-client \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/modal \
  && /opt/modal/bin/pip install --no-cache-dir modal \
  && ln -s /opt/modal/bin/modal /usr/local/bin/modal

RUN git config --system --add safe.directory '*'

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "daemon", "--", "--config", "config.dokku.json", "--sleep-seconds", "60", "--ai"]
