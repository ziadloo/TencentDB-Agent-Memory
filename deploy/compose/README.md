# Generic Compose deployment

This directory contains a single-file Docker Compose template for the complete
TencentDB Agent Memory stack. All image references, credentials, LLM settings,
service wiring, and persistent volumes are defined in `compose.yaml`.

- `memory-core`: memory and metadata gateway
- `memory-hub`: Panel plus Knowledge Service
- `memory-proxy`: LLM forwarding and memory injection proxy

## Configure and start

```bash
cd deploy/compose
$EDITOR compose.yaml
```

Replace every `CHANGE-ME` value and update `KNOWLEDGE_PUBLIC_BASE_URL` if
clients will reach the Knowledge Service through a different address. The
inline proxy configuration is generated when the proxy container starts.

Then start the stack:

```bash
docker compose -f compose.yaml pull
docker compose -f compose.yaml up -d
```

The image references use the public GHCR `:latest` tag. The Compose file uses
named volumes for all runtime data and a private bridge network for
service-to-service calls.

## GHCR package visibility

The workflow publishes the packages with `GITHUB_TOKEN`. After the first
successful release, confirm that these three packages are set to **Public** in
the repository owner's GitHub Packages settings:

- `memory-core`
- `memory-hub`
- `memory-proxy`

This is a one-time registry setting; it is intentionally not automated with a
long-lived package-administration token.

## Endpoints

| Service | Default endpoint |
| --- | --- |
| Memory Gateway | `http://localhost:8420` |
| Panel | `http://localhost:8125` |
| Knowledge Service | `http://localhost:8424/v3` |
| Proxy | `http://localhost:8096` |

The `KNOWLEDGE_PUBLIC_BASE_URL` value must be an address reachable by the
clients that will call Knowledge Service and must include `/v3`.
