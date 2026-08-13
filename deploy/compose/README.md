# Generic Compose deployment

This directory contains a generic Docker Compose template for the complete
TencentDB Agent Memory stack:

- `memory-core`: memory and metadata gateway
- `memory-hub`: Panel plus Knowledge Service
- `memory-proxy`: LLM forwarding and memory injection proxy

## Configure and start

```bash
cd deploy/compose
cp .env.example .env
cp config/proxy.yaml config/proxy.local.yaml
$EDITOR .env config/proxy.local.yaml
```

Update `compose.yaml` so the proxy mount points to `config/proxy.local.yaml`, or
copy the local file over `config/proxy.yaml`. Do not commit either file after
adding credentials.

Then start the stack:

```bash
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
```

The `IMAGE_NAMESPACE` and `IMAGE_TAG` values select the public GHCR packages.
Each release publishes both an immutable tag such as `v2.1.0` and the moving
`:latest` tag. The Compose file uses named volumes for all runtime data and a
private bridge network for service-to-service calls.

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
