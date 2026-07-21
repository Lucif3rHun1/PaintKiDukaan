const WORD_PATTERN = /\p{L}+/gu;
const SHORT_ACRONYM_PATTERN = /^[A-Z]{1,3}$/;

export function toTitleCase(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(WORD_PATTERN, (word) =>
      SHORT_ACRONYM_PATTERN.test(word)
        ? word
        : word[0].toLocaleUpperCase() + word.slice(1).toLocaleLowerCase(),
    );
}
