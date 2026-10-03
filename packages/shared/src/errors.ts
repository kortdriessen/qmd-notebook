import { RpcErrorCodes } from './protocol';

export class BridgeError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  toRpc(): { code: number; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  static notFound(what: string, data?: unknown): BridgeError {
    return new BridgeError(RpcErrorCodes.NotFound, `${what} not found`, data);
  }

  static conflict(message: string, data?: unknown): BridgeError {
    return new BridgeError(RpcErrorCodes.Conflict, message, data);
  }

  static invalidParams(message: string, data?: unknown): BridgeError {
    return new BridgeError(RpcErrorCodes.InvalidParams, message, data);
  }

  static kernelUnavailable(message: string, data?: unknown): BridgeError {
    return new BridgeError(RpcErrorCodes.KernelUnavailable, message, data);
  }

  static timeout(message: string, data?: unknown): BridgeError {
    return new BridgeError(RpcErrorCodes.Timeout, message, data);
  }

  static unauthorized(message = 'Unauthorized'): BridgeError {
    return new BridgeError(RpcErrorCodes.Unauthorized, message);
  }

  static untrusted(): BridgeError {
    return new BridgeError(
      RpcErrorCodes.Untrusted,
      'The VS Code workspace is not trusted; execution and agent mutations are disabled',
    );
  }

  static unsupported(message: string): BridgeError {
    return new BridgeError(RpcErrorCodes.Unsupported, message);
  }
}

export function isBridgeError(e: unknown): e is BridgeError {
  return e instanceof BridgeError || (typeof e === 'object' && e !== null && (e as any).name === 'BridgeError');
}
