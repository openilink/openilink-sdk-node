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
  ILINK_APP_ID,
  ILINK_CHANNEL_VERSION,
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
  APIResponse,
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
  VoiceItem,
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
  private loginBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  private readonly contextTokens = new Map<string, string>();

  constructor(token = "", config: ClientConfig = {}) {
    this.baseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.cdnBaseUrl = config.cdn_base_url ?? DEFAULT_CDN_BASE_URL;
    this.loginBaseUrl = config.base_url ?? DEFAULT_BASE_URL;
    this.token = token;
    this.botType = config.bot_type ?? DEFAULT_BOT_TYPE;
    this.version = config.version ?? ILINK_CHANNEL_VERSION;
    this.routeTag = config.route_tag ?? "";
    this.fetchImpl = config.fetch_impl ?? fetch;
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
      const response = await this.doPost("ilink/bot/getupdates", request, timeoutMs);
      return this.withRawResponse(this.decodeJson<GetUpdatesResponse>(response.body, "getUpdates"), response);
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

    await this.sendMessage(
      this.buildOutgoingMessage(to, clientId, contextToken, [
        {
          type: ITEM_TYPE_TEXT,
          text_item: {
            text,
          },
        },
      ]),
    );

    return clientId;
  }

  async getConfig(userId: string, contextToken: string): Promise<GetConfigResponse> {
    const response = await this.doPost(
      "ilink/bot/getconfig",
      {
        ilink_user_id: userId,
        context_token: contextToken,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_CONFIG_TIMEOUT,
    );

    return this.withRawResponse(this.decodeJson<GetConfigResponse>(response.body, "getConfig"), response);
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
    const response = await this.doPost(
      "ilink/bot/getuploadurl",
      {
        ...request,
        base_info: this.buildBaseInfo(),
      },
      DEFAULT_API_TIMEOUT,
    );

    return this.withRawResponse(this.decodeJson<GetUploadURLResponse>(response.body, "getUploadUrl"), response);
  }

  async fetchQRCode(): Promise<QRCodeResponse> {
    const savedBaseUrl = this.baseUrl;
    this.baseUrl = this.loginBaseUrl;
    try {
      const url = new URL(this.buildUrl("ilink/bot/get_bot_qrcode"));
      url.searchParams.set("bot_type", this.botType || DEFAULT_BOT_TYPE);

      let response: APIResponse;
      try {
        response = await this.doGetText(url.toString(), {}, DEFAULT_API_TIMEOUT);
      } catch (error) {
        throw new Error(`ilink: fetch QR code: ${this.errorMessage(error)}`, { cause: error });
      }

      try {
        return this.withRawResponse(this.decodeJson<QRCodeResponse>(response.body, "fetchQRCode"), response);
      } catch (error) {
        throw new Error(`ilink: unmarshal QR response: ${this.errorMessage(error)}`, { cause: error });
      }
    } finally {
      this.baseUrl = savedBaseUrl;
    }
  }

  async pollQRStatus(qrcode: string, baseUrl?: string): Promise<QRStatusResponse> {
    const base = (baseUrl || this.baseUrl).replace(/\/+$/, "");
    const url = new URL(`${base}/ilink/bot/get_qrcode_status`);
    url.searchParams.set("qrcode", qrcode);

    try {
      const response = await this.doGetText(
        url.toString(),
        {},
        QR_LONG_POLL_TIMEOUT,
      );

      try {
        return this.withRawResponse(this.decodeJson<QRStatusResponse>(response.body, "pollQRStatus"), response);
      } catch (error) {
        throw new Error(`ilink: unmarshal QR status: ${this.errorMessage(error)}`, { cause: error });
      }
    } catch (error) {
      if (error instanceof RequestError && error.isTimeout()) {
        return { status: "wait" };
      }

      throw error;
    }
  }

  async loginWithQr(callbacks: LoginCallbacks = {}, timeoutMs = DEFAULT_LOGIN_TIMEOUT): Promise<LoginResult> {
    const deadline = Date.now() + timeoutMs;
    const qrBaseUrl = this.loginBaseUrl;
    const qr = await this.fetchQRCode();
    let currentQr = qr.qrcode ?? "";

    callbacks.on_qrcode?.(qr.qrcode_img_content ?? "");

    let scannedNotified = false;
    let refreshCount = 1;
    let pollBaseUrl = qrBaseUrl;

    while (Date.now() <= deadline) {
      let status: QRStatusResponse;
      try {
        status = await this.pollQRStatus(currentQr, pollBaseUrl);
      } catch (error) {
        throw new Error(`ilink: poll QR status: ${this.errorMessage(error)}`, { cause: error });
      }

      switch (status.status ?? "wait") {
        case "scaned":
          if (!scannedNotified) {
            scannedNotified = true;
            callbacks.on_scanned?.();
          }
          break;

        case "scaned_but_redirect":
          if (status.redirect_host) {
            pollBaseUrl = `https://${status.redirect_host}`;
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
            let refreshedQr: QRCodeResponse;
            try {
              refreshedQr = await this.fetchQRCode();
            } catch (error) {
              throw new Error(`ilink: refresh QR code: ${this.errorMessage(error)}`, { cause: error });
            }
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
      options.on_response?.(response);

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

    await this.sendMessage(
      this.buildOutgoingMessage(to, clientId, contextToken, [
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
      ]),
    );

    return clientId;
  }

  async sendVideo(to: string, contextToken: string, uploaded: UploadResult): Promise<string> {
    const clientId = this.generateClientId();

    await this.sendMessage(
      this.buildOutgoingMessage(to, clientId, contextToken, [
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
      ]),
    );

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

    await this.sendMessage(
      this.buildOutgoingMessage(to, clientId, contextToken, [
        {
          type: ITEM_TYPE_FILE,
          file_item: fileItem,
        },
      ]),
    );

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

    let uploaded: UploadResult;
    try {
      uploaded = await this.uploadFile(payload, to, mediaType);
    } catch (error) {
      throw new Error(`ilink: upload media: ${this.errorMessage(error)}`, { cause: error });
    }

    if (caption !== "") {
      try {
        await this.sendText(to, caption, contextToken);
      } catch (error) {
        throw new Error(`ilink: send caption: ${this.errorMessage(error)}`, { cause: error });
      }
    }

    try {
      if (isVideoMIME(mime)) {
        await this.sendVideo(to, contextToken, uploaded);
        return;
      }

      if (isImageMIME(mime)) {
        await this.sendImage(to, contextToken, uploaded);
        return;
      }

      await this.sendFileAttachment(to, contextToken, fileName.split(/[\\/]/).pop() ?? fileName, uploaded);
    } catch (error) {
      throw new Error(`ilink: send media: ${this.errorMessage(error)}`, { cause: error });
    }
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

    let cdnUrl: string;
    const fullUrl = (uploadResponse.upload_full_url ?? "").trim();
    if (fullUrl) {
      cdnUrl = fullUrl;
    } else if (uploadResponse.upload_param) {
      cdnUrl = buildCdnUploadUrl(this.cdnBaseUrl, uploadResponse.upload_param, fileKey);
    } else {
      throw new Error("ilink: getUploadUrl returned no upload URL (need upload_full_url or upload_param)");
    }

    const ciphertext = encryptAesEcb(plainBytes, aesKey);
    const downloadParam = await this.uploadToCDN(cdnUrl, ciphertext);

    return {
      file_key: fileKey,
      download_encrypted_query_param: downloadParam,
      aes_key: aesKey.toString("hex"),
      file_size: rawSize,
      ciphertext_size: ciphertext.byteLength,
    };
  }

  async downloadMedia(media: CDNMedia | undefined): Promise<Uint8Array> {
    if (!media) {
      throw new Error("ilink: media is nil");
    }
    const key = parseAESKey(media.aes_key ?? "");
    const dlUrl = this.resolveCDNDownloadURL(media);
    const ciphertext = await this.doGetBytes(dlUrl, {}, DEFAULT_CDN_TIMEOUT);
    return decryptAesEcb(ciphertext, key);
  }

  async downloadMediaRaw(media: CDNMedia | undefined): Promise<Uint8Array> {
    if (!media) {
      throw new Error("ilink: media is nil");
    }
    const dlUrl = this.resolveCDNDownloadURL(media);
    return this.doGetBytes(dlUrl, {}, DEFAULT_CDN_TIMEOUT);
  }

  /** @deprecated Use {@link downloadMedia} which supports CDNMedia.full_url. */
  async downloadFile(encryptedQueryParam: string, aesKeyBase64: string): Promise<Uint8Array> {
    return this.downloadMedia({ encrypt_query_param: encryptedQueryParam, aes_key: aesKeyBase64 });
  }

  /** @deprecated Use {@link downloadMediaRaw} which supports CDNMedia.full_url. */
  async downloadRaw(encryptedQueryParam: string): Promise<Uint8Array> {
    return this.downloadMediaRaw({ encrypt_query_param: encryptedQueryParam });
  }

  async downloadVoice(voice: VoiceItem | undefined): Promise<Uint8Array> {
    if (!this.silkDecoder) {
      throw new Error("ilink: no SILK decoder configured; use config.silk_decoder or setSILKDecoder");
    }

    if (!voice?.media) {
      throw new Error("ilink: voice item or media is nil");
    }

    let silkData: Uint8Array;
    try {
      silkData = await this.downloadMedia(voice.media);
    } catch (error) {
      throw new Error(`ilink: download voice: ${this.errorMessage(error)}`, { cause: error });
    }

    let pcm: Uint8Array;
    const sampleRate = typeof voice.sample_rate === "number" && voice.sample_rate > 0 ? voice.sample_rate : DEFAULT_VOICE_SAMPLE_RATE;
    try {
      pcm = await this.silkDecoder(silkData, sampleRate);
    } catch (error) {
      throw new Error(`ilink: decode voice: ${this.errorMessage(error)}`, { cause: error });
    }

    return buildWAV(pcm, sampleRate, 1, 16);
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

  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(encodeClientVersion(this.version)),
    };
    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }
    return headers;
  }

  private buildHeaders(body?: string | Buffer, extraHeaders: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.commonHeaders(),
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": this.randomWechatUin(),
      ...extraHeaders,
    };

    if (typeof body === "string" || body instanceof Uint8Array) {
      headers["Content-Length"] = String(typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);
    }

    const token = this.token.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return headers;
  }

  private buildUploadHeaders(body: Buffer | Uint8Array): Record<string, string> {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);

    return {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(payload.byteLength),
    };
  }

  private resolveCDNDownloadURL(media: CDNMedia): string {
    if (media.full_url) {
      return media.full_url;
    }
    if (media.encrypt_query_param) {
      return buildCdnDownloadUrl(this.cdnBaseUrl, media.encrypt_query_param);
    }
    throw new Error("ilink: cdn media has no full_url or encrypt_query_param");
  }

  private async doPost(endpoint: string, payload: Record<string, unknown>, timeoutMs: number): Promise<APIResponse> {
    const body = JSON.stringify(payload);
    return this.requestText(
      "POST",
      this.buildUrl(endpoint),
      this.buildHeaders(body, { "Content-Type": "application/json" }),
      body,
      timeoutMs,
    );
  }

  private async doGetText(url: string, extraHeaders: Record<string, string>, timeoutMs: number): Promise<APIResponse> {
    return this.requestText("GET", url, { ...this.commonHeaders(), ...extraHeaders }, undefined, timeoutMs);
  }

  private async doGetBytes(url: string, extraHeaders: Record<string, string>, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.fetchResponse("GET", url, { ...this.commonHeaders(), ...extraHeaders }, undefined, timeoutMs);
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
      this.buildUploadHeaders(payload),
      payload,
      DEFAULT_CDN_TIMEOUT,
    );
    const responseBody = Buffer.from(await response.arrayBuffer());

    if (response.status !== 200) {
      const responseHeaders = this.headersToRecord(response.headers);
      const errorMessage =
        response.headers.get("x-error-message") || responseBody.toString("utf8") || `status ${response.status}`;
      throw new HTTPError(response.status, errorMessage, responseHeaders);
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
  ): Promise<APIResponse> {
    const response = await this.fetchResponse(method, url, headers, body, timeoutMs);
    const responseBody = await response.text();
    const rawResponse = this.toRawResponse(response, responseBody);

    if (response.status < 200 || response.status >= 300) {
      throw new HTTPError(response.status, responseBody, rawResponse.headers);
    }

    return rawResponse;
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
      return await this.fetchImpl(url, {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: "manual",
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

  private toRawResponse(response: Response, body: string): APIResponse {
    return {
      status_code: response.status,
      headers: this.headersToRecord(response.headers),
      body,
    };
  }

  private withRawResponse<T extends object>(decoded: T, rawResponse: APIResponse): T {
    return {
      ...decoded,
      raw_response: rawResponse,
    } as T;
  }

  private buildOutgoingMessage(
    to: string,
    clientId: string,
    contextToken: string,
    itemList: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    return {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      context_token: contextToken,
      item_list: itemList,
    };
  }

  private randomWechatUin(): string {
    const value = randomBytes(4).readUInt32BE(0).toString(10);
    return Buffer.from(value).toString("base64");
  }

  private generateClientId(): string {
    return `openclaw-weixin:${Date.now()}-${randomBytes(4).toString("hex")}`;
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

function encodeClientVersion(version: string): number {
  const parts = version.split(".").map(Number);
  const major = (parts[0] ?? 0) & 0xff;
  const minor = (parts[1] ?? 0) & 0xff;
  const patch = (parts[2] ?? 0) & 0xff;
  return (major << 16) | (minor << 8) | patch;
}
