/** Minimal typing of the VS Code notebook renderer API (subset actually used). */
export interface RendererOutputItem {
  readonly id: string;
  readonly mime: string;
  text(): string;
  json(): any;
}

export interface RendererContext<TState = unknown> {
  readonly workspace?: unknown;
  readonly settings?: { readonly lineLimit: number };
  postMessage?(message: unknown): void;
  onDidReceiveMessage?(listener: (e: unknown) => unknown): { dispose(): void };
  getState?(): TState | undefined;
  setState?(value: TState): void;
}

export interface RendererApi {
  renderOutputItem(outputItem: RendererOutputItem, element: HTMLElement, signal: AbortSignal): void;
  disposeOutputItem?(id?: string): void;
}

export type ActivationFunction = (context: RendererContext) => RendererApi | Promise<RendererApi>;
