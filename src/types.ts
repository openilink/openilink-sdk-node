export interface BaseInfo {
  channel_version?: string;
}

export interface APIResponse {
  status_code: number;
  headers: Record<string, string>;
  body: string;
}

export interface RawResponseContainer {
  raw_response?: APIResponse;
}

export type SILKDecoder = (silkData: Uint8Array, sampleRate: number) => Uint8Array | Promise<Uint8Array>;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface TextItem {
  text?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  [key: string]: unknown;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  [key: string]: unknown;
}

export interface GetUpdatesResponse extends RawResponseContainer {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  sync_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResponse extends RawResponseContainer {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface GetUploadURLRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
  base_info?: BaseInfo;
}

export interface GetUploadURLResponse extends RawResponseContainer {
  ret?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface QRCodeResponse extends RawResponseContainer {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QRStatusResponse extends RawResponseContainer {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface LoginResult {
  connected: boolean;
  bot_token?: string;
  bot_id?: string;
  base_url?: string;
  user_id?: string;
  message: string;
}

export interface LoginCallbacks {
  on_qrcode?: (url: string) => void;
  on_scanned?: () => void;
  on_expired?: (attempt: number, maxAttempts: number) => void;
}

export interface MonitorOptions {
  initial_buf?: string;
  on_buf_update?: (buf: string) => void;
  on_error?: (error: Error) => void;
  on_session_expired?: () => void;
  on_response?: (response: GetUpdatesResponse) => void;
  should_continue?: () => boolean;
}

export interface ClientConfig {
  base_url?: string;
  cdn_base_url?: string;
  bot_type?: string;
  version?: string;
  route_tag?: string;
  fetch_impl?: typeof fetch;
  silk_decoder?: SILKDecoder;
}

export interface UploadResult {
  file_key: string;
  download_encrypted_query_param: string;
  aes_key: string;
  file_size: number;
  ciphertext_size: number;
}
