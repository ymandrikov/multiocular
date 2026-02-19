# Creates development machine inside docker
# so every developer will have the same environment

# registry.fedoraproject.org/fedora:43
FROM registry.fedoraproject.org/fedora@sha256:d2b7aebba3cb091ebebf2c826296b532db9fc76b99f1bda1e288f3feb3d0f279

ARG TARGETARCH

ENV NODE_VERSION=24.13.1 \
  NODE_CHECKSUM_X64=30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089 \
  NODE_CHECKSUM_ARM64=c827d3d301e2eed1a51f36d0116b71b9e3d9e3b728f081615270ea40faac34c1

ENV PNPM_VERSION=10.30.0 \
  PNPM_CHECKSUM_X64=78d83aa009dc7e8d18faf5ea87e8cafed9601245f23757f00c3582284f54f793 \
  PNPM_CHECKSUM_ARM64=60029e565d8001de71c4f2064afd2a20cb85e346f25e980300e9cad021277a71

RUN dnf install -yq zsh micro git tig psmisc procps-ng awk openssh-server \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && mkdir -p /var/run/sshd \
  && ssh-keygen -A

RUN <<EOF
  if [ "$TARGETARCH" = "amd64" ]; then
    export NODE_CHECKSUM=$NODE_CHECKSUM_X64
    export PNPM_CHECKSUM=$PNPM_CHECKSUM_X64
    export PINACT_CHECKSUM=$PINACT_CHECKSUM_X64
    export ARCH="x64"
    export PINACT_ARCH="amd64"
  elif [ "$TARGETARCH" = "arm64" ]; then
    export NODE_CHECKSUM=$NODE_CHECKSUM_ARM64
    export PNPM_CHECKSUM=$PNPM_CHECKSUM_ARM64
    export PINACT_CHECKSUM=$PINACT_CHECKSUM_ARM64
    export ARCH="arm64"
    export PINACT_ARCH="arm64"
  else
    echo "Unsupported architecture: $TARGETARCH"
    exit 1
  fi

  curl "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    --fail --show-error --location --silent --output /node.tar.xz
  echo "$NODE_CHECKSUM /node.tar.xz" | sha256sum -c
  tar -xf /node.tar.xz -C /usr/local --remove-files --strip-components=1 \
    --exclude='*.md' --exclude='LICENSE' \
    --exclude='share' --exclude='bin/corepack'
  rm /node.tar.xz

  curl "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${ARCH}" \
    --fail --show-error --location --silent --output /usr/local/bin/pnpm
  echo "$PNPM_CHECKSUM /usr/local/bin/pnpm" | sha256sum -c
  chmod a+rx /usr/local/bin/pnpm
EOF

RUN useradd -s /bin/zsh developer
USER developer

RUN mkdir -p /home/developer/.local/share/pnpm \
  && pnpm config set store-dir /home/developer/.local/share/pnpm/store
RUN echo 'PS1="%d$ "' > ~/.zshrc
