import { createHash, randomBytes } from "node:crypto";
import {
  aesEcbPaddedSize,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  encryptAesEcb,
  mediaAesKeyHex,
  parseAESKey,
  UPLOAD_MAX_RETRIES,
} from "./cdn.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_BOT_TYPE,
  DEFAULT_CDN_BASE_URL,
  ITEM_TYPE_FILE,
  ITEM_TYPE_IMAGE,
  ITEM_TYPE_TEXT,
  ITEM_TYPE_VIDEO,
  MEDIA_FILE,
  MEDIA_IMAGE,
  MEDIA_VIDEO,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
  SESSION_EXPIRED_ERR_CODE,
} from "./constants.js";
import { APIError, HTTPError, NoContextTokenError, RequestError } from "./errors.js";
import { isImageMIME, isVideoMIME, MIMEFromFilename } from "./mime.js";
import type {
  BaseInfo,
  ClientConfig,
  CDNMedia,
  FileItem,
  GetConfigResponse,
  GetUpdatesResponse,
  GetUploadURLRequest,
  GetUploadURLResponse,
  LoginCallbacks,
  LoginResult,
  MonitorOptions,
  QRCodeResponse,
  QRStatusResponse,
  SILKDecoder,
  UploadResult,
  WeixinMessage,
} from "./types.js";
import { buildWAV, DEFAULT_VOICE_SAMPLE_RATE } from "./voice.js";

const DEFAULT_LONG_POLL_TIMEOUT = 35_000;
const DEFAULT_API_TIMEOUT = 15_000;
const DEFAULT_CONFIG_TIMEOUT = 10_000;
const QR_LONG_POLL_TIMEOUT = 35_000;
const DEFAULT_LOGIN_TIMEOUT = 480_000;
const DEFAULT_CDN_TIMEOUT = 60_000;
const MAX_QR_REFRESH_COUNT = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_PAUSE_MS = 3_600_000;

export class Client {
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
  botType: string;
  version: string;
  routeTag: string;
  silkDecoder?: SILKDecoder;

  private readonly contextTokens = new Map<string, string>();

  constructor(token = "", config: ClientConfig = {}) {
    this.baseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.cdn_base_url ?? DEFAULT_CDN_BASE_URL;
    this.token = token;
    this.botType = config.bot_type ?? DEFAULT_BOT_TYPE;
    this.version = config.version ?? "1.0.2";
    this.routeTag = config.route_tag ?? "";
    this.silkDecoder = config.silk_decoder;
  }

  setToken(token: string): void {
    this.token = token;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  setCdnBaseUrl(cdnBaseUrl: string): void {
    this.cdnBaseUrl = cdnBaseUrl;
  }

  setBotType(botType: string): void {
    this.botType = botType;
  }

  setVersion(version: string): void {
    this.version = version;
  }

  setRouteTag(routeTag: string): void {
    this.routeTag = routeTag;
  }

  setSILKDecoder(silkDecoder: SILKDecoder): void {
    this.silkDecoder = silkDecoder;
  }

  async getUpdates(getUpdatesBuf = "", timeoutMs = DEFAULT_LONG_POLL_TIMEOUT): Promise<GetUpdatesResponse> {
    const request = {
      get_updates_buf: getUpdatesBuf,
      base_info: this.buildBaseInfo(),
    };

    try {
      const body = await this.doPost("ilink/bot/getupdates", request, timeoutMs);
      return this.decodeJson<GetUpdatesResponse>(body, "getUpdates");
    } catch (error) {
      if (error instanceof RequestError && error.isTimeout()) {
        return {
          ret: 0,
          msgs: [],
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
    const clientId = this.generateClientId();

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

  async getConfig(userId: string, contextToken: string): Promise<GetConfigResponse> {
    const body = await this.doPost(
      "ilink/bot/getconfig",
      {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_CONFIG_TIMEOUT,
    );

    return this.decodeJson<GetConfigResponse>(body, "getConfig");
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
      DEFAULT_CONFIG_TIMEOUT,
    );
  }

  async getUploadUrl(request: GetUploadURLRequest): Promise<GetUploadURLResponse> {
    const body = await this.doPost(
      "ilink/bot/getuploadurl",
      {
        ...request,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_API_TIMEOUT,
    );

    return this.decodeJson<GetUploadURLResponse>(body, "getUploadUrl");
  }

  async fetchQRCode(): Promise<QRCodeResponse> {
    const url = new URL(this.buildUrl("ilink/bot/get_bot_qrcode"));
    url.searchParams.set("bot_type", this.botType || DEFAULT_BOT_TYPE);

    const body = await this.doGetText(url.toString(), this.routeTagHeaders(), DEFAULT_API_TIMEOUT);
    return this.decodeJson<QRCodeResponse>(body, "fetchQRCode");
  }

  async pollQRStatus(qrcode: string): Promise<QRStatusResponse> {
    const url = new URL(this.buildUrl("ilink/bot/get_qrcode_status"));
    url.searchParams.set("qrcode", qrcode);

    try {
      const body = await this.doGetText(
        url.toString(),
        {
          ...this.routeTagHeaders(),
          "iLink-App-ClientVersion": "1",
        },
        QR_LONG_POLL_TIMEOUT,
      );

      return this.decodeJson<QRStatusResponse>(body, "pollQRStatus");
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
    let currentQr = qr.qrcode ?? "";

    callbacks.on_qrcode?.(qr.qrcode_img_content ?? "");

    let scannedNotified = false;
    let refreshCount = 1;

    while (Date.now() <= deadline) {
      const status = await this.pollQRStatus(currentQr);

      switch (status.status ?? "wait") {
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
              message: "QR code expired too many times",
            };
          }

          callbacks.on_expired?.(refreshCount, MAX_QR_REFRESH_COUNT);

          {
            const refreshedQr = await this.fetchQRCode();
            currentQr = refreshedQr.qrcode ?? "";
            scannedNotified = false;
            callbacks.on_qrcode?.(refreshedQr.qrcode_img_content ?? "");
          }
          break;

        case "confirmed": {
          const botId = status.ilink_bot_id ?? "";
          if (botId === "") {
            return {
              connected: false,
              message: "server did not return bot ID",
            };
          }

          this.token = status.bot_token ?? "";
          if (status.baseurl) {
            this.baseUrl = status.baseurl;
          }

          return {
            connected: true,
            bot_token: status.bot_token ?? "",
            bot_id: botId,
            base_url: status.baseurl ?? "",
            user_id: status.ilink_user_id ?? "",
            message: "connected",
          };
        }
      }

      await this.sleep(1_000);
    }

    return {
      connected: false,
      message: "login timeout",
    };
  }

  async monitor(
    handler: (message: WeixinMessage) => void | Promise<void>,
    options: MonitorOptions = {},
  ): Promise<void> {
    let buf = options.initial_buf ?? "";
    let failures = 0;
    let nextTimeoutMs: number | undefined;
    const onError = options.on_error ?? (() => {});

    while (this.shouldContinue(options.should_continue)) {
      let response: GetUpdatesResponse;

      try {
        response = await this.getUpdates(buf, nextTimeoutMs);
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

      if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
        nextTimeoutMs = response.longpolling_timeout_ms;
      }

      const ret = Number(response.ret ?? 0);
      const errCode = Number(response.errcode ?? 0);

      if (ret !== 0 || errCode !== 0) {
        const apiError = new APIError(ret, errCode, String(response.errmsg ?? ""));

        if (apiError.isSessionExpired()) {
          options.on_session_expired?.();
          onError(apiError);
          failures = 0;
          await this.sleep(SESSION_EXPIRED_PAUSE_MS, options.should_continue);
          continue;
        }

        failures += 1;
        onError(new Error(`getUpdates (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${apiError.message}`));

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
        buf = response.get_updates_buf;
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

  async sendImage(to: string, contextToken: string, uploaded: UploadResult): Promise<string> {
    const clientId = this.generateClientId();

    await this.sendMessage({
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [
        {
          type: ITEM_TYPE_IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.download_encrypted_query_param,
              aes_key: mediaAesKeyHex(uploaded.aes_key),
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertext_size,
          },
        },
      ],
    });

    return clientId;
  }

  async sendVideo(to: string, contextToken: string, uploaded: UploadResult): Promise<string> {
    const clientId = this.generateClientId();

    await this.sendMessage({
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [
        {
          type: ITEM_TYPE_VIDEO,
          video_item: {
            media: {
              encrypt_query_param: uploaded.download_encrypted_query_param,
              aes_key: mediaAesKeyHex(uploaded.aes_key),
              encrypt_type: 1,
            },
            video_size: uploaded.ciphertext_size,
          },
        },
      ],
    });

    return clientId;
  }

  async sendFileAttachment(
    to: string,
    contextToken: string,
    fileName: string,
    uploaded: UploadResult,
  ): Promise<string> {
    const clientId = this.generateClientId();
    const fileItem: FileItem = {
      media: {
        encrypt_query_param: uploaded.download_encrypted_query_param,
        aes_key: mediaAesKeyHex(uploaded.aes_key),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.file_size),
    };

    await this.sendMessage({
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: [
        {
          type: ITEM_TYPE_FILE,
          file_item: fileItem,
        },
      ],
    });

    return clientId;
  }

  async sendMediaFile(
    to: string,
    contextToken: string,
    data: Uint8Array | ArrayBuffer,
    fileName: string,
    caption = "",
  ): Promise<void> {
    const payload = this.toBuffer(data);
    const mime = MIMEFromFilename(fileName);

    let mediaType = MEDIA_FILE;
    if (isVideoMIME(mime)) {
      mediaType = MEDIA_VIDEO;
    } else if (isImageMIME(mime)) {
      mediaType = MEDIA_IMAGE;
    }

    const uploaded = await this.uploadFile(payload, to, mediaType);

    if (caption !== "") {
      await this.sendText(to, caption, contextToken);
    }

    if (isVideoMIME(mime)) {
      await this.sendVideo(to, contextToken, uploaded);
      return;
    }

    if (isImageMIME(mime)) {
      await this.sendImage(to, contextToken, uploaded);
      return;
    }

    await this.sendFileAttachment(to, contextToken, fileName.split(/[\\/]/).pop() ?? fileName, uploaded);
  }

  async uploadFile(
    plaintext: Uint8Array | ArrayBuffer,
    toUserId: string,
    mediaType: number,
  ): Promise<UploadResult> {
    const plainBytes = this.toBuffer(plaintext);
    const rawSize = plainBytes.byteLength;
    const rawMd5 = createHash("md5").update(plainBytes).digest("hex");
    const fileSize = aesEcbPaddedSize(rawSize);
    const fileKey = this.randomHex(16);
    const aesKey = randomBytes(16);

    const uploadResponse = await this.getUploadUrl({
      filekey: fileKey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: fileSize,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    });

    if ((uploadResponse.ret ?? 0) !== 0) {
      throw new APIError(uploadResponse.ret ?? 0, 0, uploadResponse.errmsg ?? "");
    }

    if (!uploadResponse.upload_param) {
      throw new Error("ilink: getUploadUrl returned no upload_param");
    }

    const ciphertext = encryptAesEcb(plainBytes, aesKey);
    const cdnUrl = buildCdnUploadUrl(this.cdnBaseUrl, uploadResponse.upload_param, fileKey);
    const downloadParam = await this.uploadToCDN(cdnUrl, ciphertext);

    return {
      file_key: fileKey,
      download_encrypted_query_param: downloadParam,
      aes_key: aesKey.toString("hex"),
      file_size: rawSize,
      ciphertext_size: ciphertext.byteLength,
    };
  }

  async downloadFile(encryptedQueryParam: string, aesKeyBase64: string): Promise<Uint8Array> {
    const key = parseAESKey(aesKeyBase64);
    const downloadUrl = buildCdnDownloadUrl(this.cdnBaseUrl, encryptedQueryParam);
    const ciphertext = await this.doGetBytes(downloadUrl, {}, DEFAULT_CDN_TIMEOUT);
    return decryptAesEcb(ciphertext, key);
  }

  async downloadRaw(encryptedQueryParam: string): Promise<Uint8Array> {
    const downloadUrl = buildCdnDownloadUrl(this.cdnBaseUrl, encryptedQueryParam);
    return this.doGetBytes(downloadUrl, {}, DEFAULT_CDN_TIMEOUT);
  }

  async downloadVoice(media: CDNMedia | undefined): Promise<Uint8Array> {
    if (!this.silkDecoder) {
      throw new Error("ilink: no SILK decoder configured; use config.silk_decoder or setSILKDecoder");
    }

    if (!media) {
      throw new Error("ilink: voice media is nil");
    }

    const encryptedQueryParam = media.encrypt_query_param ?? "";
    const aesKey = media.aes_key ?? "";
    const silkData = await this.downloadFile(encryptedQueryParam, aesKey);
    const pcm = await this.silkDecoder(silkData, DEFAULT_VOICE_SAMPLE_RATE);
    return buildWAV(pcm, DEFAULT_VOICE_SAMPLE_RATE, 1, 16);
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

  private buildHeaders(body?: string | Buffer, extraHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": this.randomWechatUin(),
      ...extraHeaders,
    };

    if (typeof body === "string" || body instanceof Uint8Array) {
      headers["Content-Length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
    }

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    return headers;
  }

  private routeTagHeaders(): Record<string, string> {
    return this.routeTag ? { SKRouteTag: this.routeTag } : {};
  }

  private async doPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const body = JSON.stringify(payload);
    return this.requestText(
      "POST",
      this.buildUrl(endpoint),
      this.buildHeaders(body, { "Content-Type": "application/json" }),
      body,
      timeoutMs,
    );
  }

  private async doGetText(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
    return this.requestText("GET", url, headers, undefined, timeoutMs);
  }

  private async doGetBytes(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.fetchResponse("GET", url, headers, undefined, timeoutMs);
    const body = new Uint8Array(await response.arrayBuffer());

    if (response.status < 200 || response.status >= 300) {
      throw new HTTPError(response.status, this.toBuffer(body), this.headersToRecord(response.headers));
    }

    return body;
  }

  private async uploadToCDN(cdnUrl: string, ciphertext: Uint8Array): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
      try {
        return await this.doUpload(cdnUrl, ciphertext);
      } catch (error) {
        lastError = error;

        if (error instanceof HTTPError && error.statusCode >= 400 && error.statusCode < 500) {
          throw error;
        }

        if (attempt < UPLOAD_MAX_RETRIES) {
          await this.sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(`ilink: cdn upload failed after ${UPLOAD_MAX_RETRIES} attempts: ${this.errorMessage(lastError)}`);
  }

  private async doUpload(cdnUrl: string, body: Uint8Array): Promise<string> {
    const payload = this.toBuffer(body);
    const response = await this.fetchResponse(
      "POST",
      cdnUrl,
      this.buildHeaders(payload, { "Content-Type": "application/octet-stream" }),
      payload,
      DEFAULT_CDN_TIMEOUT,
    );
    const responseBody = Buffer.from(await response.arrayBuffer());

    if (response.status !== 200) {
      throw new HTTPError(response.status, responseBody, this.headersToRecord(response.headers));
    }

    const downloadParam = response.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error("ilink: cdn response missing x-encrypted-param header");
    }

    return downloadParam;
  }

  private async requestText(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const response = await this.fetchResponse(method, url, headers, body, timeoutMs);
    const responseBody = await response.text();

    if (response.status < 200 || response.status >= 300) {
      throw new HTTPError(response.status, responseBody, this.headersToRecord(response.headers));
    }

    return responseBody;
  }

  private async fetchResponse(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | Buffer | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        method,
        headers,
        body: body as BodyInit | undefined,
        signal: controller.signal,
      });
    } catch (error) {
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

  private headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};

    headers.forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });

    return record;
  }

  private randomWechatUin(): string {
    const value = randomBytes(4).readUInt32BE(0).toString(10);
    return Buffer.from(value).toString("base64");
  }

  private generateClientId(): string {
    return `sdk-${Date.now()}-${randomBytes(4).toString("hex")}`;
  }

  private randomHex(n: number): string {
    return randomBytes(n).toString("hex");
  }

  private toBuffer(data: Uint8Array | ArrayBuffer): Buffer {
    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }

    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
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
