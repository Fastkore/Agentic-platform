declare module 'saxen' {
  export class Parser {
    on(event: 'openTag', handler: (name: string, attributes: () => Record<string, string>, decode: (value: string) => string) => void): void;
    on(event: 'closeTag', handler: (name: string) => void): void;
    on(event: 'text', handler: (value: string) => void): void;
    on(event: 'error' | 'warn' | 'attention', handler: () => void): void;
    parse(xml: string): void;
  }
}
