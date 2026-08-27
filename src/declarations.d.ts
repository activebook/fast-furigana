declare module "kuroshiro" {
  export interface KuroshiroConvertOptions {
    to?: "hiragana" | "katakana" | "romaji";
    mode?: "normal" | "spaced" | "okurigana" | "furigana";
    delimiter_start?: string;
    delimiter_end?: string;
  }

  export default class Kuroshiro {
    constructor();
    init(analyzer: unknown): Promise<void>;
    convert(text: string, options?: KuroshiroConvertOptions): Promise<string>;
  }
}

declare module "kuroshiro-analyzer-kuromoji" {
  export interface KuromojiAnalyzerOptions {
    dictPath?: string;
  }

  export default class KuromojiAnalyzer {
    constructor(options?: KuromojiAnalyzerOptions);
  }
}

declare module "url-join" {
  export default function urlJoin(...parts: string[]): string;
}
