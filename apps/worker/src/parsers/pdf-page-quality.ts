export type PdfPageQuality = "ok" | "low_quality";
export type PdfPageQualityResult = {
  quality: PdfPageQuality;
  readableCharacterRatio: number;
  replacementCharacterRatio: number;
  controlCharacterRatio: number;
  nonWhitespaceLength: number;
};

/** Conservative, local-only check: never calls a model and never changes page text. */
export function checkPdfPageQuality(text: string): PdfPageQualityResult {
  const characters = [...text];
  const total = characters.length;
  const readable = characters.filter((char) => !/\s/u.test(char) && !/[\p{Cc}\uFFFD]/u.test(char)).length;
  const replacement = characters.filter((char) => char === "\uFFFD").length;
  const controls = characters.filter((char) => /[\p{Cc}\p{Cf}]/u.test(char) && char !== "\n" && char !== "\r" && char !== "\t").length;
  const nonWhitespaceLength = characters.filter((char) => !/\s/u.test(char)).length;
  const readableCharacterRatio = total ? readable / total : 0;
  const replacementCharacterRatio = total ? replacement / total : 0;
  const controlCharacterRatio = total ? controls / total : 0;
  const quality = nonWhitespaceLength < 3 || readableCharacterRatio < 0.4 || replacementCharacterRatio > 0.01 || controlCharacterRatio > 0.05
    ? "low_quality" : "ok";
  return { quality, readableCharacterRatio, replacementCharacterRatio, controlCharacterRatio, nonWhitespaceLength };
}
