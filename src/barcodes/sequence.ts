export interface GenerateSequenceLabelsOptions {
  prefix: string;
  start: number;
  count: number;
  padWidth: number;
  suffix: string;
  lines: [string, string, string];
  targetLineIndex: 0 | 1 | 2;
}

export interface SequenceLabel {
  line1: string;
  line2: string;
  line3: string;
}

function zeroPad(value: number, width: number): string {
  return Math.max(0, Math.floor(value))
    .toString()
    .padStart(Math.max(0, width), "0");
}

export function generateSequenceLabels(
  opts: GenerateSequenceLabelsOptions,
): SequenceLabel[] {
  const {
    prefix,
    start,
    count,
    padWidth,
    suffix,
    lines,
    targetLineIndex,
  } = opts;

  const result: SequenceLabel[] = [];

  for (let i = 0; i < count; i++) {
    const seqValue = `${prefix}${zeroPad(start + i, padWidth)}${suffix}`;
    const targetLine = lines[targetLineIndex];

    const filledLine = targetLine.includes("{seq}")
      ? targetLine.replaceAll("{seq}", seqValue)
      : seqValue;

    const label: SequenceLabel = {
      line1: lines[0],
      line2: lines[1],
      line3: lines[2],
    };

    if (targetLineIndex === 0) {
      label.line1 = filledLine;
    } else if (targetLineIndex === 1) {
      label.line2 = filledLine;
    } else {
      label.line3 = filledLine;
    }

    result.push(label);
  }

  return result;
}
