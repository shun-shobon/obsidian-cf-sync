export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  text: string;
  bytes: ArrayBuffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
