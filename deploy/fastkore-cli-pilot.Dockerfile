FROM node:24.19.0-bookworm-slim AS node
FROM mcr.microsoft.com/dotnet/runtime:10.0-noble
WORKDIR /opt/fastkore-cli
COPY app/ ./
COPY Docs/ ./Docs/
COPY Examples/ ./Examples/
COPY README-LINUX.md ./
COPY --chmod=755 fastkore-cli /usr/local/bin/fastkore-cli
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY fastkore-cli-pilot.mjs ./pilot.mjs
RUN install -d -o app -g app /workspace && install -d -o app -g 1000 -m 0750 /run/fastkore-cli
ENV HOME=/tmp XDG_DATA_HOME=/tmp/.local/share
USER $APP_UID:1000
WORKDIR /workspace
CMD ["node", "/opt/fastkore-cli/pilot.mjs"]
