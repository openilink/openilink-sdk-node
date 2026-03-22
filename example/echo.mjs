import { Client, extractText } from "../dist/index.js";

const client = new Client("");

console.log("正在获取登录二维码...");

const result = await client.loginWithQr({
  on_qrcode: (url) => {
    console.log(`\n请用微信扫描二维码:\n${url}\n`);
  },
  on_scanned: () => {
    console.log("已扫码，请在微信上确认...");
  },
  on_expired: (attempt, max) => {
    console.log(`二维码已过期，正在刷新 (${attempt}/${max})...`);
  },
});

if (!result.connected) {
  console.error(`登录未完成: ${result.message}`);
  process.exit(1);
}

console.log(`登录成功! BotID=${result.bot_id ?? ""} UserID=${result.user_id ?? ""}`);

let running = true;
let initialBuf = "";

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    running = false;
  });
}

console.log("开始监听消息... (Ctrl+C 退出)");

await client.monitor(
  async (message) => {
    const text = extractText(message);
    if (!text) {
      return;
    }

    const fromUserId = String(message.from_user_id ?? "");
    const contextToken = String(message.context_token ?? "");

    console.log(`[来自 ${fromUserId}]: ${text}`);

    try {
      await client.sendText(fromUserId, `收到: ${text}`, contextToken);
    } catch (error) {
      console.error(`回复失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  {
    initial_buf: initialBuf,
    on_buf_update: (buf) => {
      initialBuf = buf;
    },
    should_continue: () => running,
  },
);

console.log("已退出");
