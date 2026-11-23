# The image of the containerized agents. The runner mounts the clone at /work and a private home at /home/agent, and
# nothing else from the host. The CLI versions are part of the cache key, so they are written here, not "latest":
# `pnpm eval:image --latest` writes the last published versions of codex and opencode, then builds.
FROM node:24.22.1-trixie
ARG CODEX_VERSION=0.171.0
# opencode 2 is published as @opencode/cli; opencode-ai stops at 1.x. The runner reads OPENCODE_VERSION for its options.
ARG OPENCODE_PACKAGE=@opencode/cli
ARG OPENCODE_VERSION=2.4.0
# pnpm for the tasks of a pnpm repo: the proxy lets no package registry through, so corepack cannot fetch it. Keep it at
# the packageManager version of the task repos (consonus: 11.8.0): another version fetches that one, and the proxy refuses.
ARG PNPM_VERSION=11.8.0
RUN npm install -g --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" "${OPENCODE_PACKAGE}@${OPENCODE_VERSION}" "pnpm@${PNPM_VERSION}" \
	&& npm cache clean --force \
	&& apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
# The network filter of the run. It runs in its own container from this image: see proxy.ts.
COPY proxy.ts /opt/eval-runner/proxy.ts
ENV HOME=/home/agent
WORKDIR /work
