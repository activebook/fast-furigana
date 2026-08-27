export interface ConvertItem {
  text: string;
  nextContext?: string;
}

export interface ConvertBatchRequest {
  id?: number;
  type: "convert_batch";
  contents: Array<string | ConvertItem>;
}

export interface ConvertSingleRequest {
  id?: number;
  type: "convert";
  content: string | ConvertItem;
}

export interface PingRequest {
  id?: number;
  type: "ping";
}

export type OffscreenRequest = ConvertBatchRequest | ConvertSingleRequest | PingRequest;

export interface OffscreenSuccessResponse<T = string> {
  id?: number;
  ok: true;
  result?: T;
  results?: T[];
}

export interface OffscreenErrorResponse {
  id?: number;
  ok: false;
  error: string;
}

export type OffscreenResponse<T = string> = OffscreenSuccessResponse<T> | OffscreenErrorResponse;

export interface ContentInitMessage {
  type: "init";
}

export interface ToggleMessage {
  type: "toggle";
}

export interface GetStateMessage {
  type: "get_state";
}

export interface StateChangedMessage {
  type: "state_changed";
  active: boolean;
}

export type ContentScriptMessage = ContentInitMessage | ToggleMessage | GetStateMessage;

export type RuntimeMessage = OffscreenRequest | ContentScriptMessage | StateChangedMessage;
