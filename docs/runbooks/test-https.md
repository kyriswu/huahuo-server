# 测试域名 HTTPS 运维

宿主 Nginx + Certbot 为两个回环服务提供 HTTPS：

| 域名 | 上游 | `.env` 公开地址 |
|---|---|---|
| `test-api.chuda.cc` | `http://127.0.0.1:3000` | `APP_PUBLIC_BASE_URL=https://test-api.chuda.cc` |
| `test-admin.chuda.cc` | `http://127.0.0.1:3001` | `ADMIN_PUBLIC_BASE_URL=https://test-admin.chuda.cc` |

两域名配置时的 A 记录为 `112.126.81.226`。HTTP 除 `/.well-known/acme-challenge/` 外均跳转 HTTPS；Admin 首页跳转 `/admin`。

## 配置维护

- API：[Nginx 配置](../../infra/nginx/test-api.chuda.cc.conf)、[续期钩子](../../infra/nginx/renew-test-api.sh)。支持 WebSocket、关闭缓冲，上传上限 100 MiB，代理读写超时 300 秒。
- Admin：[Nginx 配置](../../infra/nginx/test-admin.chuda.cc.conf)、[续期钩子](../../infra/nginx/renew-test-admin.sh)。请求体上限 1 MiB，管理会话 Cookie 设置 Secure、HttpOnly、SameSite=Strict。
- 两入口使用 TLS 1.2/1.3、HTTP/2，访问日志省略查询参数。API/Admin 的 3000/3001 端口保持回环绑定。
- 站点配置安装于 `/etc/nginx/sites-available/<域名>`，通过 `sites-enabled` 同名链接启用。证书及私钥位于 `/etc/letsencrypt/live/<域名>/`，不进入仓库。

以下命令用于已有证书和站点链接的配置更新，在仓库根目录执行：

```bash
for domain in test-api.chuda.cc test-admin.chuda.cc; do
  install -m 0644 "infra/nginx/$domain.conf" "/etc/nginx/sites-available/$domain"
done
install -m 0755 infra/nginx/renew-test-api.sh /etc/letsencrypt/renewal-hooks/deploy/huahuo-test-api-nginx.sh
install -m 0755 infra/nginx/renew-test-admin.sh /etc/letsencrypt/renewal-hooks/deploy/huahuo-test-admin-nginx.sh
nginx -t && systemctl reload nginx
```

## 自动续期

`snap.certbot.renew.timer` 定时调用 Certbot 检查证书，仅在接近到期时续期，无需额外 cron。成功续期后，对应域名的 deploy hook 执行 `nginx -t`，通过后 reload Nginx。

HTTP-01 校验使用宿主 webroot `/var/lib/letsencrypt`。保持 DNS 指向本机、Nginx 运行和公网 80 端口可达即可，后端服务停止不影响续期。

```bash
systemctl status snap.certbot.renew.timer --no-pager
systemctl list-timers snap.certbot.renew.timer --all --no-pager
certbot certificates
```

需要诊断时，对目标域名执行续期演练；`--run-deploy-hooks` 会在模拟成功后检查并 reload Nginx：

```bash
certbot renew --cert-name test-api.chuda.cc --dry-run --run-deploy-hooks \
  --no-random-sleep-on-renew --non-interactive
# Admin 使用 --cert-name test-admin.chuda.cc
```

## 恢复服务后检查

截至 2026-11-14，项目容器按用户要求保持停止，Nginx 和续期定时器运行。以下检查需待后端恢复后执行，使用系统信任库验证证书：

```bash
curl --fail --show-error https://test-api.chuda.cc/health/ready
curl --fail --show-error https://test-admin.chuda.cc/health/ready
curl --head --header 'Accept: text/html' https://test-admin.chuda.cc/admin
```

`/admin` 在 HTML 请求下提供登录页；无会话且未请求 HTML 时返回 401。2026-11-07 的真实域名、证书签发及续期演练已通过；未验证管理员登录会话，也不代表 App 端到端或 P16 完整验收。
