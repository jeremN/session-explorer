# The image of the containerized agents. The runner mounts the clone at /work and a private home at /home/agent, and
# nothing else from the host. Pin the CLI versions: they are part of the cache key.
FROM node:24.22.1-trixie
ARG CODEX_VERSION=0.166.0
ARG OPENCODE_VERSION=1.19.6
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" "opencode-ai@${OPENCODE_VERSION}" \
	&& npm cache clean --force \
	&& apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
# The network filter of the run. It runs in its own container from this image: see proxy.ts.
COPY proxy.ts /opt/eval-runner/proxy.ts
ENV HOME=/home/agent
WORKDIR /work
