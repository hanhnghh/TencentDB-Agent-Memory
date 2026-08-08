FROM node:22-bookworm

# Agent Memory spans Node/TypeScript services, a Python SDK, SQLite-backed
# runtime code, native Node modules, shell deployment scripts, and GitHub
# Issues. Keep the image capable of running each package's local feedback loop.
RUN apt-get update && apt-get install -y \
  build-essential \
  ca-certificates \
  git \
  curl \
  jq \
  libsqlite3-dev \
  openssh-client \
  pkg-config \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv \
  python-is-python3 \
  ripgrep \
  shellcheck \
  sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g "$AGENT_GID" node \
  && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" \
       -d /home/agent -m -l agent node \
  && install -d -o "$AGENT_UID" -g "$AGENT_GID" -m 700 /home/agent/.codex

# Install Codex CLI (run as root before USER agent)
RUN corepack enable \
  && npm install -g @openai/codex \
  && codex --version \
  && gh --version \
  && node --version \
  && python3 --version \
  && sqlite3 --version

# Keep the Python SDK feedback loop available without creating and populating a
# fresh virtualenv in every issue worktree. Project source remains bind-mounted;
# this environment only supplies the SDK's declared runtime/dev tools.
RUN python3 -m venv /opt/sandcastle-python \
  && /opt/sandcastle-python/bin/pip install --no-cache-dir \
       "httpx>=0.24.0" \
       "pytest>=7.0" \
       "pytest-asyncio>=0.21" \
       "respx>=0.20" \
       build \
       hatchling \
       "python-dotenv>=1.0"

USER ${AGENT_UID}:${AGENT_GID}

WORKDIR /home/agent

ENV HOME=/home/agent
ENV CODEX_HOME=/home/agent/.codex
ENV PYTHONUNBUFFERED=1
ENV PATH=/opt/sandcastle-python/bin:${PATH}

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
