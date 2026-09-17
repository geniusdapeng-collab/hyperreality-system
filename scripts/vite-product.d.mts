export interface WorkLoomViteProduct {
  readonly define: Readonly<Record<string, string>>;
  readonly plugin: {
    readonly name: string;
    transformIndexHtml(html: string): string;
  };
}

export function workloomProductVite(clientLabel: string): WorkLoomViteProduct;
