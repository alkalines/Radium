# Durable Streams has no upstream image. This one is the upstream release binary (a static Go
# build of Caddy with the durable_streams plugin), checked against the release's checksums.txt.
# To upgrade, change VERSION and both checksums from that release's checksums.txt.

FROM alpine:3.22 AS download
ARG VERSION=0.3.0
ARG SHA256_AMD64=120b03d91ad67adfb265bac72e2d06cae07c333621598b32ee3b0ae21d11acb9
ARG SHA256_ARM64=7e908cb5bac87d7299e9529779993afe3bf223ad1e58b044e6face7e111c3914
ARG TARGETARCH
RUN apk add --no-cache curl
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum="$SHA256_AMD64" ;; \
      arm64) sum="$SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    file="durable-streams-server_${VERSION}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSLo "/tmp/$file" "https://github.com/durable-streams/durable-streams/releases/download/v${VERSION}/$file"; \
    echo "$sum  /tmp/$file" | sha256sum -c -; \
    tar -xzf "/tmp/$file" -C /tmp durable-streams-server; \
    mkdir /data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=download /tmp/durable-streams-server /usr/local/bin/durable-streams-server
COPY --from=download --chown=nonroot:nonroot /data /data
COPY Caddyfile /etc/durable-streams/Caddyfile
VOLUME /data
EXPOSE 4437
ENTRYPOINT ["/usr/local/bin/durable-streams-server", "run", "--config", "/etc/durable-streams/Caddyfile", "--adapter", "caddyfile"]
