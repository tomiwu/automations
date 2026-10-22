declare module "kody:runtime" {
  /** Durable key-value storage of the calling package. */
  export function packageStorage(): {
    get(key: string): Promise<unknown>;
    set(key: string, value: string): Promise<unknown>;
  };
}
