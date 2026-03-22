import { randomBytes } from "node:crypto";
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_CDN_BASE_URL,
  ITEM_TYPE_TEXT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
  SESSION_EXPIRED_ERR_CODE,
} from "./constants.js";
import { NoContextTokenError, RequestError } from "./errors.js";
import type {
  BaseInfo,
  ClientConfig,
  GetUpdatesResponse,
  LoginCallbacks,
  LoginResult,
  MonitorOptions,
  WeixinMessage,
} from "./types.js";

const DEFAULT_LONG_POLL_TIMEOUT = 35_000;
const DEFAULT_API_TIMEOUT = 15_000;
const QR_LONG_POLL_TIMEOUT = 35_000;
const DEFAULT_LOGIN_TIMEOUT = 480_000;
const MAX_QR_REFRESH_COUNT = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export class Client {
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  botType: string;
  version: string;
  private readonly contextTokens = new Map<string, string>();

  constructor(token = "", config: ClientConfig = {}) {
    this.baseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.cdn_base_url ?? DEFAULT_CDN_BASE_URL;
    this.token = token;
    this.botType = config.bot_type ?? DEFAULT_BOT_TYPE;
    this.version = config.version ?? "1.0.0";
  }

  async getUpdates(getUpdatesBuf = ""): Promise<GetUpdatesResponse> {
    const request = {
      get_updates_buf: getUpdatesBuf,
      base_info: this.buildBaseInfo(),
    };

    try {
      const body = await this.doPost("ilink/bot/getupdates", request, DEFAULT_LONG_POLL_TIMEOUT + 5_000);
      return this.decodeJson<GetUpdatesResponse>(body, "getUpdates");
    } catch (error) {
      if (error instanceof RequestError && error.isTimeout()) {
        return {
          ret: 0,
          get_updates_buf: getUpdatesBuf,
        };
      }

      throw error;
    }
  }

  async sendMessage(message: Record<string, unknown>): Promise<void> {
    await this.doPost(
      "ilink/bot/sendmessage",
      {
        msg: message,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_API_TIMEOUT,
    );
  }

  async sendText(to: string, text: string, contextToken: string): Promise<string> {
    const clientId = `sdk-${Date.now()}`;

    await this.sendMessage({
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [
        {
          type: ITEM_TYPE_TEXT,
          text_item: {
            text,
          },
        },
      ],
    });

    return clientId;
  }

  async getConfig(userId: string, contextToken: string): Promise<Record<string, unknown>> {
    const body = await this.doPost(
      "ilink/bot/getconfig",
      {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: this.buildBaseInfo(),
      },
      10_000,
    );

    return this.decodeJson<Record<string, unknown>>(body, "getConfig");
  }

  async sendTyping(userId: string, typingTicket: string, status: number): Promise<void> {
    await this.doPost(
      "ilink/bot/sendtyping",
      {
        ilink_user_id: userId,
        typing_ticket: typingTicket,
        status,
        base_info: this.buildBaseInfo(),
      },
      10_000,
    );
  }

  async getUploadUrl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = await this.doPost(
      "ilink/bot/getuploadurl",
      {
        ...request,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_API_TIMEOUT,
    );

    return this.decodeJson<Record<string, unknown>>(body, "getUploadUrl");
  }

  async fetchQRCode(): Promise<Record<string, unknown>> {
    const url = new URL(this.buildUrl("ilink/bot/get_bot_qrcode"));
    url.searchParams.set("bot_type", this.botType || DEFAULT_BOT_TYPE);

    const body = await this.doGet(url.toString(), {}, DEFAULT_API_TIMEOUT);
    return this.decodeJson<Record<string, unknown>>(body, "fetchQRCode");
  }

  async pollQRStatus(qrcode: string): Promise<Record<string, unknown>> {
    const url = new URL(this.buildUrl("ilink/bot/get_qrcode_status"));
    url.searchParams.set("qrcode", qrcode);

    try {
      const body = await this.doGet(
        url.toString(),
        {
          "iLink-App-ClientVersion": "1",
        },
        QR_LONG_POLL_TIMEOUT + 5_000,
      );

      return this.decodeJson<Record<string, unknown>>(body, "pollQRStatus");
    } catch (error) {
      if (error instanceof RequestError && error.isTimeout()) {
        return { status: "wait" };
      }

      throw error;
    }
  }

  async loginWithQr(callbacks: LoginCallbacks = {}, timeoutMs = DEFAULT_LOGIN_TIMEOUT): Promise<LoginResult> {
    const deadline = Date.now() + timeoutMs;
    const qr = await this.fetchQRCode();
    let currentQr = String(qr.qrcode ?? "");

    callbacks.on_qrcode?.(String(qr.qrcode_img_content ?? ""));

    let scannedNotified = false;
    let refreshCount = 1;

    while (Date.now() <= deadline) {
      const status = await this.pollQRStatus(currentQr);

      switch (String(status.status ?? "wait")) {
        case "scaned":
          if (!scannedNotified) {
            scannedNotified = true;
            callbacks.on_scanned?.();
          }
          break;

        case "expired":
          refreshCount += 1;
          if (refreshCount > MAX_QR_REFRESH_COUNT) {
            return {
              connected: false,
              message: "登录超时：二维码多次过期。",
            };
          }

          callbacks.on_expired?.(refreshCount, MAX_QR_REFRESH_COUNT);

          {
            const refreshedQr = await this.fetchQRCode();
            currentQr = String(refreshedQr.qrcode ?? "");
            scannedNotified = false;
            callbacks.on_qrcode?.(String(refreshedQr.qrcode_img_content ?? ""));
          }
          break;

        case "confirmed": {
          const botId = String(status.ilink_bot_id ?? "");
          if (botId === "") {
            return {
              connected: false,
              message: "登录失败：服务器未返回 bot ID。",
            };
          }

          this.token = String(status.bot_token ?? "");
          if (status.baseurl) {
            this.baseUrl = String(status.baseurl);
          }

          return {
            connected: true,
            bot_token: String(status.bot_token ?? ""),
            bot_id: botId,
            base_url: String(status.baseurl ?? ""),
            user_id: String(status.ilink_user_id ?? ""),
            message: "与微信连接成功！",
          };
        }
      }

      await this.sleep(1_000);
    }

    return {
      connected: false,
      message: "登录超时，请重试。",
    };
  }

  async monitor(handler: (message: WeixinMessage) => void | Promise<void>, options: MonitorOptions = {}): Promise<void> {
    let buf = options.initial_buf ?? "";
    let failures = 0;
    const onError = options.on_error ?? (() => {});

    while (this.shouldContinue(options.should_continue)) {
      let response: GetUpdatesResponse;

      try {
        response = await this.getUpdates(buf);
      } catch (error) {
        failures += 1;
        onError(new Error(`getUpdates (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${this.errorMessage(error)}`));

        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await this.sleep(BACKOFF_DELAY_MS, options.should_continue);
        } else {
          await this.sleep(RETRY_DELAY_MS, options.should_continue);
        }

        continue;
      }

      const ret = Number(response.ret ?? 0);
      const errCode = Number(response.errcode ?? 0);

      if (ret !== 0 || errCode !== 0) {
        if (ret === SESSION_EXPIRED_ERR_CODE || errCode === SESSION_EXPIRED_ERR_CODE) {
          options.on_session_expired?.();
          onError(new Error("session expired (errcode -14), pausing 5 min"));
          await this.sleep(300_000, options.should_continue);
          continue;
        }

        failures += 1;
        onError(
          new Error(
            `getUpdates ret=${ret} errcode=${errCode} msg=${String(response.errmsg ?? "")} (${failures}/${MAX_CONSECUTIVE_FAILURES})`,
          ),
        );

        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await this.sleep(BACKOFF_DELAY_MS, options.should_continue);
        } else {
          await this.sleep(RETRY_DELAY_MS, options.should_continue);
        }

        continue;
      }

      failures = 0;

      if (response.get_updates_buf) {
        buf = String(response.get_updates_buf);
        options.on_buf_update?.(buf);
      }

      for (const message of response.msgs ?? []) {
        if (message.context_token && message.from_user_id) {
          this.setContextToken(message.from_user_id, message.context_token);
        }

        await handler(message);
      }
    }
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token);
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  async push(to: string, text: string): Promise<string> {
    const token = this.getContextToken(to);
    if (!token) {
      throw new NoContextTokenError();
    }

    return this.sendText(to, text, token);
  }

  private buildBaseInfo(): BaseInfo {
    return {
      channel_version: this.version,
    };
  }

  private buildUrl(endpoint: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  }

  private async doPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-WECHAT-UIN": this.randomWechatUin(),
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return this.request("POST", this.buildUrl(endpoint), headers, body, timeoutMs);
  }

  private async doGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
    return this.request("GET", url, headers, undefined, timeoutMs);
  }

  private async request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const responseBody = await response.text();
      if (response.status >= 400) {
        throw new RequestError(`HTTP ${response.status}: ${responseBody}`, {
          statusCode: response.status,
          responseBody,
        });
      }

      return responseBody;
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }

      throw new RequestError(`HTTP request failed: ${this.errorMessage(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private decodeJson<T>(body: string, operation: string): T {
    let decoded: unknown;

    try {
      decoded = JSON.parse(body);
    } catch (error) {
      throw new Error(`Failed to decode ${operation} response: ${this.errorMessage(error)}`);
    }

    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error(`${operation} response is not a JSON object.`);
    }

    return decoded as T;
  }

  private randomWechatUin(): string {
    const value = randomBytes(4).readUInt32BE(0).toString(10);
    return Buffer.from(value).toString("base64");
  }

  private shouldContinue(callback?: () => boolean): boolean {
    return callback ? callback() : true;
  }

  private async sleep(ms: number, shouldContinue?: () => boolean): Promise<void> {
    const deadline = Date.now() + ms;

    while (Date.now() < deadline) {
      if (shouldContinue && !this.shouldContinue(shouldContinue)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
