/**
 * A stub for the `obsidian` module.
 *
 * Only the handful of runtime values the plugin actually imports. Everything
 * else it uses from Obsidian is a type, which disappears at compile time — a
 * property the plugin was written to preserve, so that the parts worth testing
 * can be tested at all.
 */

export class Notice {
  static readonly shown: string[] = [];
  constructor(
    readonly message: string | DocumentFragment,
    readonly timeout?: number,
  ) {
    Notice.shown.push(String(message));
  }
  setMessage(): this {
    return this;
  }
  hide(): void {}
}

export class FileSystemAdapter {
  getBasePath(): string {
    return process.cwd();
  }
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
}

/** Overridable per test; the default refuses so nothing hits the network. */
export let requestUrlImpl: (param: RequestUrlParam) => Promise<RequestUrlResponse> = async () => ({
  status: 404,
  headers: {},
  text: '',
  json: null,
});

export function setRequestUrl(impl: typeof requestUrlImpl): void {
  requestUrlImpl = impl;
}

export function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
  return requestUrlImpl(param);
}

export class Plugin {}
export class ItemView {}
export class Modal {}
export class Setting {}
export class PluginSettingTab {}
export class Menu {}
export class TFile {}
export class TFolder {}
export function setIcon(): void {}
