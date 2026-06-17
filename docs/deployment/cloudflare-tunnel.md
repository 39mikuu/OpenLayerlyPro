# Cloudflare Tunnel Deployment

Cloudflare Tunnel is useful when the server has no public IP.

Existing detailed guide: [../deploy-cloudflare-tunnel.md](../deploy-cloudflare-tunnel.md)

## Summary

1. Create a Tunnel in Cloudflare Zero Trust.
2. Add a Public Hostname that points to `http://app:3000`.
3. Set:

```env
APP_URL=https://your-domain.example
CLOUDFLARE_TUNNEL_TOKEN=...
TRUSTED_PROXY_HEADER=cf-connecting-ip
TRUSTED_PROXY_HOPS=1
```

4. Start:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

## Security Notes

- Do not expose the app container port directly to the public internet.
- Use Cloudflare's `cf-connecting-ip` header only when traffic reaches the app through Cloudflare-controlled paths.
- Keep Turnstile secret keys server-side.
