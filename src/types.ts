export interface BaseInfo {
  channel_version: string;
}

export interface TextItem {
  text: string;
}

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  [key: string]: unknown;
}

export interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: MessageItem[];
  [key: string]: unknown;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  [key: string]: unknown;
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
  should_continue?: () => boolean;
}

export interface ClientConfig {
  base_url?: string;
  cdn_base_url?: string;
  bot_type?: string;
  version?: string;
}
