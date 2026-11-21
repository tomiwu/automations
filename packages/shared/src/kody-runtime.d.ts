declare module "kody:runtime" {
  export function packageStorage(): {
    get(key: string): Promise<unknown>;
    set(key: string, value: string): Promise<unknown>;
  };

  export const packageContext:
    | {
        readonly hostedUrl?: string;
        readonly appBasePath?: string;
        readonly assetBasePath?: string;
        readonly clientModuleUrl?: string;
      }
    | undefined;
}
