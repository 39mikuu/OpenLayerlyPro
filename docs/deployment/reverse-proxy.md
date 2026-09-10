# Reverse Proxy Deployment

Use a reverse proxy when deploying on a VPS or home server with a public ingress.

Existing guides:

- [../deploy-vps.md](../deploy-vps.md)
- [../deploy-cdn.md](../deploy-cdn.md)
- [../architecture/deployment-network-edge.md](../architecture/deployment-network-edge.md)

## Caddy Overlay

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Set:

```env
APP_DOMAIN=your-domain.example
APP_URL=https://your-domain.example
TRUSTED_PROXY_HEADER=x-forwarded-for
TRUSTED_PROXY_HOPS=1
```

## Trusted IP Headers

The app does not trust forwarded IP headers by default. Configure `TRUSTED_PROXY_HOPS` only for proxy layers you control. If the origin port is directly reachable by users, do not trust single-value headers such as `x-real-ip` or `cf-connecting-ip`.

Public reverse-proxy deployments that use the base Compose file must set `DIRECT_COMPOSE_AUTH_ALLOW_UNRESOLVED_CLIENT_IP=false`; the supplied Caddy and Cloudflare Tunnel overlays enforce the resulting runtime `AUTH_ALLOW_UNRESOLVED_CLIENT_IP=false` value even though the base trusted-LAN direct Compose mode enables the exception.
