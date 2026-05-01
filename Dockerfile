FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    git \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN git config --system --add safe.directory '*'

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npm", "run", "daemon", "--", "--config", "config.dokku.json", "--sleep-seconds", "60", "--ai"]
