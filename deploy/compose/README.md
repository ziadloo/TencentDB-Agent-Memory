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
explicit host-path mounts for all runtime data and a private bridge network for
service-to-service calls.

Before starting the application, replace the three `/mnt/tank/...` paths in
`compose.yaml` with the actual host dataset paths:

| Host dataset | Container path | Purpose |
| --- | --- | --- |
| `/mnt/tank/apps/tencentdb-agent-memory/core` | `/data/tdai-memory` | MemoryCore data |
| `/mnt/tank/apps/tencentdb-agent-memory/hub` | `/data/knowledge` | Panel and Knowledge data |
| `/mnt/tank/apps/tencentdb-agent-memory/proxy` | `/data/tdai-memory-proxy` | Proxy state and SQLite data |

Create the datasets first and ensure the containers can write to them. The
proxy runs as a non-root user, so its dataset permissions must allow writes by
the container user.

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
| Remote MCP | `http://localhost:8425/mcp` |
| Proxy | `http://localhost:8096` |

The remote MCP endpoint is served directly by the `memory-hub` container. Put
your public HTTPS URL in the reverse proxy, for example:

```text
https://memory.example.com/mcp  →  memory-hub:8425/mcp
```

The remote endpoint expects a per-user MemoryCore user key as its bearer token.
Set `MEMORY_CORE_API_KEY` to the internal gateway key in `compose.yaml`; this
key stays inside the deployment. Configure the user key in the MCP client:

```bash
codex mcp add tencentdb-memory --url https://memory.example.com/mcp \
  --bearer-token-env-var TENCENTDB_MEMORY_USER_KEY
export TENCENTDB_MEMORY_USER_KEY='your-user-key'
```

The endpoint exposes Wiki, CodeGraph, MemoryCore memory, Skill, Knowledge, and
workspace-discovery tools. Read operations are broadly available; writes are
explicitly named, and destructive operations require confirmation. The
existing stdio MCP server remains available for local integrations.

The `KNOWLEDGE_PUBLIC_BASE_URL` value must be an address reachable by the
clients that will call Knowledge Service and must include `/v3`.
