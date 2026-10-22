declare module "kody:runtime" {
  /** Durable key-value storage of the calling package. */
  export function packageStorage(): {
    get(key: string): Promise<unknown>;
    set(key: string, value: string): Promise<unknown>;
  };

  /** Mount path of the package app. Present when the module runs as the app. */
  export const packageContext:
    | {
        readonly hostedUrl?: string;
        readonly appBasePath?: string;
        readonly assetBasePath?: string;
        readonly clientModuleUrl?: string;
      }
    | undefined;
}
