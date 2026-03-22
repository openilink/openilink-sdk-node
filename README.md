# @openilink/openilink-sdk-node

`@openilink/openilink-sdk-node` 是一个面向 OpenILink Bot API 的 Node.js SDK，提供常用能力的轻量封装，便于在 Node.js 项目中快速完成登录、收发消息和会话相关操作。

当前支持的核心能力：

- 二维码登录
- 长轮询接收消息
- 发送文本消息
- 发送图片、视频、文件消息
- 获取会话配置
- 发送打字状态
- CDN 上传下载与 AES-128-ECB 加解密
- 语音消息解码（可插拔 SILK 解码器 + WAV 封装）
- 获取上传 URL
- 缓存 `context_token` 并主动推送文本
- 结构化错误类型（`APIError`、`HTTPError`）

## 安装

```bash
npm install @openilink/openilink-sdk-node
```

要求：

- Node.js 18+

## 快速开始

```ts
import { Client, extractText } from "@openilink/openilink-sdk-node";

const client = new Client("");

const result = await client.loginWithQr({
  on_qrcode: (url) => {
    console.log(`请扫码:\n${url}`);
  },
  on_scanned: () => {
    console.log("已扫码，请在微信中确认");
  },
});

if (!result.connected) {
  throw new Error(result.message);
}

await client.monitor(async (message) => {
  const text = extractText(message);
  if (!text) {
    return;
  }

  await client.sendText(String(message.from_user_id), `收到: ${text}`, String(message.context_token));
});
```

完整示例见 [example/echo.mjs](./example/echo.mjs)。

## API

### 创建客户端

```ts
const client = new Client("", {
  base_url: "https://ilinkai.weixin.qq.com",
  cdn_base_url: "https://novac2c.cdn.weixin.qq.com/c2c",
  bot_type: "3",
  version: "1.0.2",
  route_tag: "gray-a",
  silk_decoder: async (silkData, sampleRate) => {
    // 返回 PCM 16-bit LE mono
    return decodeSilkSomehow(silkData, sampleRate);
  },
});
```

### 登录

```ts
const result = await client.loginWithQr({
  on_qrcode: (url) => {},
  on_scanned: () => {},
  on_expired: (attempt, max) => {},
});
```

返回值示例：

```ts
{
  connected: true,
  bot_token: "xxx",
  bot_id: "xxx",
  base_url: "https://...",
  user_id: "xxx",
  message: "connected",
}
```

### 收消息

```ts
const response = await client.getUpdates(buf);
```

或直接进入监听循环：

```ts
await client.monitor(
  async (message) => {
    // 处理单条消息
  },
  {
    initial_buf: "",
    on_buf_update: (buf) => {},
    on_error: (error) => {},
    on_session_expired: () => {},
    should_continue: () => true,
  },
);
```

### 发消息

```ts
const clientId = await client.sendText(toUserId, "hello", contextToken);
```

如果目标用户已经有缓存的 `context_token`：

```ts
const clientId = await client.push(toUserId, "hello");
```

发送媒体：

```ts
import { MEDIA_IMAGE } from "@openilink/openilink-sdk-node";

const uploaded = await client.uploadFile(fileBytes, toUserId, MEDIA_IMAGE);
await client.sendImage(toUserId, contextToken, uploaded);

await client.sendMediaFile(toUserId, contextToken, fileBytes, "report.pdf", "请查收");
```

### 工具方法

提取文本：

```ts
const text = extractText(message);
```

发送打字状态：

```ts
await client.sendTyping(userId, typingTicket, 1);
```

获取上传 URL：

```ts
const upload = await client.getUploadUrl({
  filekey: "demo.jpg",
  media_type: 1,
  to_user_id: toUserId,
  rawsize: 12345,
  rawfilemd5: "...",
  filesize: 12345,
  no_need_thumb: true,
  aeskey: "...",
});
```

CDN 下载：

```ts
const raw = await client.downloadRaw(encryptedQueryParam);
const plain = await client.downloadFile(encryptedQueryParam, aesKeyBase64);
```

语音消息解码：

```ts
import { buildWAV, Client } from "@openilink/openilink-sdk-node";

const client = new Client(token, {
  silk_decoder: async (silkData, sampleRate) => {
    return decodeSilkSomehow(silkData, sampleRate);
  },
});

const wav = await client.downloadVoice(message.item_list?.[0]?.voice_item?.media);
const wrapped = buildWAV(pcmBytes, 24000, 1, 16);
```

错误处理：

```ts
import { APIError, HTTPError, NoContextTokenError } from "@openilink/openilink-sdk-node";

if (error instanceof APIError && error.isSessionExpired()) {
  // 重新登录
}

if (error instanceof HTTPError) {
  console.log(error.statusCode);
}

if (error instanceof NoContextTokenError) {
  // 用户还没有 context_token
}
```
