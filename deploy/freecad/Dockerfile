FROM debian:bookworm-slim AS packages
# Download the Bookworm packages concurrently. apt verifies the selected packages at installation.
RUN apt-get update && mkdir -p /var/cache/apt/archives && apt-get --print-uris -y --no-install-recommends install python3 libfreecad-python3-0.20 freecad-common \
    | sed -n "s/^'\([^']*\)' \([^ ]*\) .*/\1 \2/p" \
    | xargs -r -P 24 -n 2 sh -c '/usr/lib/apt/apt-helper download-file "$1" "/var/cache/apt/archives/$2"' sh

FROM debian:bookworm-slim
RUN --mount=from=packages,source=/var/cache/apt/archives,target=/var/cache/apt/archives,rw \
    --mount=from=packages,source=/var/lib/apt/lists,target=/var/lib/apt/lists,rw \
    apt-get --no-download install -y --no-install-recommends python3 libfreecad-python3-0.20 freecad-common \
    && useradd --uid 1000 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin cad
ENV PYTHONPATH=/usr/lib/freecad-python3/lib HOME=/tmp LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1
WORKDIR /opt/freecad-worker
COPY *.py *.brep.gz ./
USER 1000:1000
CMD ["/usr/bin/python3", "service.py"]
