# Yedu Cloud · 夜读云作品库服务

**Yedu Cloud（夜读云）** 是夜读的云端作品后端，当前默认使用 **Cloudflare R2**：

- 用户把 `script.json`、可选封面、可选图包 `pack.zip` 直传 R2；
- 上传完成后把标题、简介、作者、标签、封面等信息回传服务端入库；
- 服务端提供公开作品列表、详情和下载地址；
- AK/SK 只存在服务端环境变量里，不进入 APK；
- **R2 预签名 URL 不需要绑定自定义域名，也不需要 ICP 备案**；
- 元数据存 SQLite，默认 Docker 数据卷持久化。

## 1. 整体流程

```text
App
  ├─ 注册设备，拿 deviceToken
  ├─ POST /works 创建草稿
  ├─ POST /works/:id/presign 获取每个文件的预签名 PUT URL
  ├─ PUT 文件到 R2（script.json / cover / pack.zip）
  ├─ POST /works/:id/finalize 回传标题、封面等元数据并发布
  ├─ GET /works 查看云端所有作品
  └─ GET /works/:id/download 获取预签名下载 URL
```

服务端只负责签名和元数据，不代理文件内容。

## 2. R2 准备

1. 登录 Cloudflare，进入 **R2**，创建一个 Bucket，例如 `yedu`。
2. 在 R2 的 **Manage API Tokens** 创建 API Token：
   - 权限：**Object Read & Write**
   - 范围：只允许目标 Bucket
3. 记录 **Access Key ID**、**Secret Access Key**。
4. 在 R2 Overview 找到 **Account ID**。
5. 不需要给 R2 绑定自定义域名。预签名 URL 使用：
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
6. 如果以后想用 R2 公共 CDN，再绑定自定义域名即可；当前预签名下载不需要。

> R2 的 `r2.dev` 公共开发地址不适合生产；当前服务不使用它。

## 3. 配置

```bash
cd server
cp .env.example .env
openssl rand -hex 32   # 填到 SERVER_SECRET
```

`.env` 关键项：

```dotenv
STORAGE_DRIVER=s3
R2_ACCOUNT_ID=你的 Cloudflare Account ID
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=yedu
R2_REGION=auto
SERVER_SECRET=至少32位随机字符串
DB_PATH=./data/yedu.db
```

`.env` 已在 `.gitignore` 中，不要提交。

## 4. 运行

### 直接运行

要求 Node.js 22.5+（使用内置 `node:sqlite`）。

```bash
npm install
npm start
```

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

Docker 使用命名卷 `yedu-data` 保存 SQLite 数据库。

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 5. 接口

### 注册设备

```http
POST /api/v1/device/register
Content-Type: application/json

{}
```

返回 `deviceId`、`token`、`expiresAt`、`keyPrefix`。设备 ID 由服务端生成，客户端不能指定别人的目录。

后续签名接口统一带：

```http
Authorization: Bearer <deviceToken>
```

Token 过期可调用：

```http
POST /api/v1/device/refresh
Authorization: Bearer <旧 token>
```

### 创建作品草稿

```http
POST /api/v1/works
Authorization: Bearer <deviceToken>
Content-Type: application/json

{
  "title": "雨夜来客",
  "description": "一个雨夜故事",
  "author": "蒋磊",
  "tags": ["悬疑", "雨夜"],
  "nodeCount": 4,
  "imageCount": 5
}
```

返回 `id`、`status: "draft"` 和当前作品的 `keyPrefix`。

### 获取上传预签名 URL

```http
POST /api/v1/works/:id/presign
Authorization: Bearer <deviceToken>
Content-Type: application/json

{
  "files": [
    { "kind": "script", "name": "script.json", "size": 12345, "contentType": "application/json" },
    { "kind": "cover",  "name": "cover.png",  "size": 200000, "contentType": "image/png" },
    { "kind": "pack",   "name": "pack.zip",   "size": 8000000, "contentType": "application/zip" }
  ]
}
```

- `script` 必传；
- `cover`、`pack` 可选；
- `size` 必须是真实文件字节数，服务端会限制 `MAX_UPLOAD_BYTES`；
- 服务端固定使用 `script.json`、`cover.<ext>`、`pack.zip` 作为对象 key。

返回示例：

```json
{
  "workId": "...",
  "files": [
    {
      "kind": "script",
      "key": "yedu/<deviceId>/works/<workId>/script.json",
      "mode": "put",
      "uploadUrl": "https://<bucket>.<account>.r2.cloudflarestorage.com/...&X-Amz-Signature=...",
      "method": "PUT",
      "headers": { "Content-Type": "application/json", "Content-Length": "12345" },
      "expiresAt": 1760000000
    }
  ]
}
```

App 对每个文件执行 `PUT uploadUrl`，请求体为文件字节，并带上返回的 `headers`。预签名 URL 已包含权限，不需要额外 `Authorization`。

### 发布作品

文件上传完成后：

```http
POST /api/v1/works/:id/finalize
Authorization: Bearer <deviceToken>
Content-Type: application/json

{
  "title": "雨夜来客",
  "description": "一个雨夜故事",
  "author": "蒋磊",
  "tags": ["悬疑", "雨夜"],
  "nodeCount": 4,
  "imageCount": 5
}
```

服务端会检查 R2 中的文件是否存在，然后写入元数据并把作品设为 `published`。

### 查看云端作品列表

```http
GET /api/v1/works?page=1&pageSize=20&q=雨夜
```

返回：

```json
{
  "items": [
    {
      "id": "...",
      "title": "雨夜来客",
      "description": "...",
      "author": "蒋磊",
      "tags": ["悬疑", "雨夜"],
      "coverUrl": "https://...X-Amz-Signature=...",
      "nodeCount": 4,
      "imageCount": 5,
      "sizeBytes": 8212345,
      "downloadCount": 0,
      "createdAt": "...",
      "updatedAt": "...",
      "publishedAt": "..."
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1,
  "totalPages": 1
}
```

只返回 `published` 作品；草稿不会出现在公开列表。

### 查看作品详情

```http
GET /api/v1/works/:id
```

### 下载作品

```http
GET /api/v1/works/:id/download
```

返回剧本、图包和封面的预签名下载地址：

```json
{
  "id": "...",
  "title": "雨夜来客",
  "script": { "name": "script.json", "url": "...", "expiresAt": 1760000000 },
  "pack":   { "name": "pack.zip",   "url": "...", "expiresAt": 1760000000 },
  "cover":  { "name": "cover.png",  "url": "...", "expiresAt": 1760000000 }
}
```

`pack` 或 `cover` 未上传时为 `null`。

## 6. 文件格式约定

```text
yedu/<deviceId>/works/<workId>/
├── script.json
├── cover.png / cover.jpg / cover.webp   # 可选
└── pack.zip                              # 可选，包含 images/
```

图包解压后建议保持夜读现有目录结构：

```text
images/<imageId>.png
```

## 7. 部署与 HTTPS

App 需要通过 HTTPS 访问签名服务。家用服务器推荐：

- **Cloudflare Tunnel**：不用开放路由器端口，直接给 API 一个 HTTPS 域名；
- 或者 Caddy / Nginx 反代 + 自己的域名和证书。

```bash
# 示例：Cloudflare Tunnel 把本地 8787 映射到 api.example.com
cloudflared tunnel --url http://127.0.0.1:8787
```

正式使用请用命名 Tunnel 和固定域名；本机测试可用临时 URL。

## 8. 数据与安全

- SQLite 只存元数据，不存文件；
- `works` 表包含标题、简介、作者、标签、封面 key、脚本 key、图包 key、大小、下载次数和时间；
- 设备和作品有归属关系，只有设备本人能预签名和发布自己的草稿；
- 公开列表和下载不需要登录，符合“云端作品库”场景；
- 预签名 URL 有有效期，过期后重新请求；
- 服务端限制 key 前缀、文件类型、单文件大小和接口频率；
- 当前没有内容审核、举报、删除和账号体系，正式对很多人开放前需要补这些能力；
- 公网服务仍要遵守当地法律和服务条款；R2 存储本身不需要 ICP，但 API 服务器/域名是否涉及备案需按部署位置自行确认。

## 9. 可选：继续使用七牛

```dotenv
STORAGE_DRIVER=qiniu
QINIU_ACCESS_KEY=...
QINIU_SECRET_KEY=...
QINIU_BUCKET=...
QINIU_DOMAIN=https://cdn.example.com
```

七牛国内空间绑定自定义域名需要 ICP 备案，且测试域名只有 30 天、不能用于生产。因此默认推荐 R2。

## 10. 测试

```bash
npm test
```

测试使用内存 SQLite 和假存储，不会访问 Cloudflare 网络。