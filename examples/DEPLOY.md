# Running the demo on your server

The goal: `demo.ziplogger.dev` shows a live storefront, six services report into a demo
workspace, and a client can sign in with a read-only account to look around.

## 1. Create the demo workspace

Sign up at <https://app.ziplogger.dev/signup> with:

- **Organization:** `Northwind Coffee` (this is the workspace name a client sees)
- **Email:** an address you control, for example `demo@ziplogger.dev`
- **Password:** anything; you will not hand this out, clients get a separate viewer login

Signup asks for a card because every account is card-gated. Nothing is charged, and the
account is switched to complimentary afterwards so it never can be.

## 2. Two API keys

In the demo workspace, **Settings → API keys**, create two:

- `demo-services` for the five backend services
- `demo-browser` for the storefront

Keep them separate. The browser key is visible in page source to anyone who opens
devtools, which is inherent to browser telemetry.

## 3. A read-only login for clients

**Settings → Users → Invite**, role **Viewer**. A Viewer can read everything and change
nothing: no alerts, dashboards, health checks, repositories, or billing. That is what
makes a shared demo login safe to send out.

## 4. Deploy

On the server:

```bash
git clone https://github.com/ziploggerhq/ZipLogger_Client.git
cd ZipLogger_Client/examples
cp .env.example .env
```

Fill `.env` with the two keys, then:

```bash
docker compose -f docker-compose.demo.yml up -d --build
```

The storefront listens on `STOREFRONT_HOST_PORT` (8095 by default). Nothing else
publishes a port.

## 5. Point demo.ziplogger.dev at it

DNS: an `A` record for `demo` at the server address, proxied through Cloudflare like the
other hostnames.

nginx, alongside the existing vhosts:

```nginx
server {
    listen 443 ssl http2;
    server_name demo.ziplogger.dev;

    ssl_certificate     /etc/letsencrypt/live/ziplogger.dev/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ziplogger.dev/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8095;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Reload with `nginx -t && systemctl reload nginx`.

## 6. Check it

```bash
curl -s https://demo.ziplogger.dev/config.js
curl -s https://demo.ziplogger.dev/checkout/health
docker compose -f docker-compose.demo.yml logs --tail 20 payments
```

Then open the storefront, click a few products, and confirm six services appear in the
demo workspace. The five background services generate traffic on their own; the
storefront only reports when someone is looking at it, which is the honest behavior for
browser telemetry.

## What a client sees

Send them the storefront link and the viewer login. A good order to walk through:

1. **Logs** filtered to `source:payments` — the same workspace holds six languages
2. An **error** with its stack trace, then the commit that introduced it
3. **Traces**, where a storefront click and the .NET checkout call share one trace id
4. **Metrics** for `request.duration` on the checkout API

## Keeping the demo tidy

Traces without errors are deleted after 48 hours, so the trace view stays representative
without growing forever. If the demo data ever needs a reset, delete by query in the demo
workspace rather than dropping the tenant, which would invalidate the keys and the viewer
login.
