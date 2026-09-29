type ClassValue = string | number | false | null | undefined | ClassDictionary | ClassArray;
type ClassDictionary = Record<string, boolean | null | undefined>;
type ClassArray = ClassValue[];

function toClassNames(value: ClassValue, out: string[]): void {
  if (!value && value !== 0) return;
  if (typeof value === "string" || typeof value === "number") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) toClassNames(v, out);
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v) out.push(k);
    }
  }
}

export function cn(...classes: ClassValue[]): string {
  const out: string[] = [];
  for (const c of classes) toClassNames(c, out);
  return out.join(" ");
}
