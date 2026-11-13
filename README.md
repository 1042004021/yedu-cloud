# 夜读七牛云签名服务

这是一个**只签发签名、不代理文件**的最小后端：

- App 先注册设备，拿到设备 Token；
- App 带设备 Token 请求上传 Token；
- App 直传七牛；
- App 带设备 Token 请求私有下载签名 URL，再从七牛下载。

AK/SK 只存在服务端环境变量里，不进入 APK。

## 1. 环境要求

- Node.js 20+，或 Docker / Docker Compose
- 一台可被手机访问的服务器
- 一个七牛 Bucket 和访问域名
- 建议用 Caddy / Nginx 提供 HTTPS；Android 9+ 默认禁止明文 HTTP

## 2. 七牛准备

1. 创建 Bucket，建议选择**私有空间**。
2. **正式使用必须绑定自定义域名**，例如 `https://cdn.example.com`。
3. 在七牛控制台获取 AccessKey / SecretKey。
4. 如果使用区域上传域名，把 `QINIU_UPLOAD_HOST` 改成对应区域，例如 `https://upload-z2.qiniup.com`；不确定时先保持默认 `https://upload.qiniup.com`。

> 七牛新空间会自动分配一个**测试域名**，通常只有 30 天有效期、每日流量限额，且明确不能用于生产。
> 测试域名只适合联调；正式发布必须绑定自己的域名。国内区域通常还要求域名 ICP 备案并配置 CNAME/HTTPS。
> 上传走 `upload.qiniup.com` 这类上传服务域名，不要求自定义域名；**下载域名**才需要绑定。

## 3. 配置

```bash
cd server
cp .env.example .env
openssl rand -hex 32   # 把结果填到 SERVER_SECRET
```

编辑 `.env`：

```dotenv
QINIU_ACCESS_KEY=...
QINIU_SECRET_KEY=...
QINIU_BUCKET=...
# 正式环境必须换成已绑定到 Bucket 的自定义域名；测试域名只用于联调
QINIU_DOMAIN=https://cdn.example.com
QINIU_PRIVATE=true
SERVER_SECRET=...
```

`.env` 已在 `.gitignore` 中，不要提交。

## 4. 运行

### 直接运行

```bash
npm install
npm start
```

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 5. API

所有签名接口都需要：

```http
Authorization: Bearer <deviceToken>
```

### 注册设备

设备 ID 由服务端生成，客户端不能指定别人的设备目录。

```http
POST /api/v1/device/register
Content-Type: application/json

{}
```

返回：

```json
{
  "deviceId": "5d7c1d89-...",
  "token": "...",
  "expiresAt": 1760000000,
  "keyPrefix": "yedu/5d7c1d89-.../"
}
```

设备 Token 是服务端 HMAC 签名的短期凭证，不存数据库；正式多用户产品建议替换为账号登录。

### 刷新设备 Token

Token 过期后，可以用旧 Token 换取新 Token（旧 Token 必须是本服务签发的有效签名）：

```http
POST /api/v1/device/refresh
Authorization: Bearer <deviceToken>
```

### 获取上传 Token

```http
POST /api/v1/qiniu/upload-token
Content-Type: application/json
Authorization: Bearer <deviceToken>

{"key":"yedu/<deviceId>/scripts/demo/images/scene_01.png"}
```

返回：

```json
{
  "key": "yedu/<deviceId>/scripts/demo/images/scene_01.png",
  "uploadHost": "https://upload.qiniup.com",
  "uploadToken": "...",
  "expiresAt": 1760000000
}
```

App 用七牛表单上传：`POST {uploadHost}`，multipart 字段 `token`、`key`、`file`。

### 获取下载 URL

```http
GET /api/v1/qiniu/download-url?key=yedu%2F<deviceId>%2Fscripts%2Fdemo%2Fimages%2Fscene_01.png
Authorization: Bearer <deviceToken>
```

返回：

```json
{
  "key": "...",
  "url": "https://cdn.example.com/...",
  "expiresAt": 1760000000
}
```

私有空间返回带过期时间的签名 URL；公开空间直接返回域名 URL。

### 当前设备

```http
GET /api/v1/me
Authorization: Bearer <deviceToken>
```

## 6. key 规则

服务端只允许：

- 位于当前设备目录：`yedu/<deviceId>/...`
- 扩展名：`.png`、`.jpg`、`.jpeg`、`.webp`、`.json`
- 不允许 `..`、反斜杠、空段、超长 key

建议 App 使用：

```text
yedu/<deviceId>/scripts/<scriptKey>/script.json
yedu/<deviceId>/scripts/<scriptKey>/save.json
yedu/<deviceId>/scripts/<scriptKey>/images/<imageId>.png
```

## 7. HTTPS 反代示例

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请证书。把 `auth.example.com` 换成你的域名，并确保手机能访问。

## 8. 安全边界

- 当前是“轻量设备身份”，不是账号体系；任何人都能注册设备，适合先跑通流程。
- 正式发布前建议增加账号登录、设备绑定、服务端配额和七牛回调校验。
- 服务端只签发上传 Token 和下载 URL，不保存文件；文件生命周期由七牛 Bucket 管理。
- 建议给 Bucket 配置防盗链、用量告警和生命周期规则。
- 公开空间适合封面等公共素材；用户存档和私人 CG 建议使用私有空间。

## 9. 测试

```bash
npm test
```

测试使用假密钥，不会访问七牛网络。
