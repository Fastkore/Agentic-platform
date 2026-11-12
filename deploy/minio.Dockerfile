FROM golang:1.25-alpine AS build
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOBIN=/out go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM alpine:3.23
COPY --from=build /out/minio /usr/local/bin/minio
RUN mkdir -p /objects && chown 1000:1000 /objects
ENV HOME=/tmp MINIO_BROWSER=off MINIO_UPDATE=off
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/objects", "--address", ":9000"]
