/** A rectangular table of cell text. Row 0 is the header row when `opts.hdr` is true. */
export type Grid = string[][];

/** Per-column conditioning rules (Column conditions tab). */
export interface ColumnRules {
  /** Leave the column out of the output. */
  na: boolean;
  /** "#": strip quote characters from the value. */
  n: boolean;
  /** "\"#\"": add quotes around the value. */
  q: boolean;
  /** b_tf: 1 → true, 0 → false. */
  tf: boolean;
  /** b_10: true → 1, false → 0. */
  t10: boolean;
  /** b_r: invert b_tf / b_10. */
  r: boolean;
  /** Value substituted for empty cells ("" = leave empty). */
  def: string;
}

/** Rules applied to every column name (JSON key). */
export interface NameRule {
  /** Strip quote characters from names. */
  n: boolean;
  /** Add quotes around names. */
  q: boolean;
}

export type Shape = "objects" | "keyed" | "arrays";
export type EmptyMode = "null" | "str" | "omit";
export type KeyCase = "asis" | "camel" | "snake";
export type Indent = "2" | "4" | "tab";
export type BoolFmt = "lower" | "title" | "upper" | "short";
export type NullFmt = "null" | "Null" | "NULL" | "None";
export type OrderMode = "custom" | "table";

export interface ConvertOptions {
  hdr: boolean;
  shape: Shape;
  empty: EmptyMode;
  keys: KeyCase;
  infer: boolean;
  nest: boolean;
  indent: Indent;
  applyCond: boolean;
  renderOrder: OrderMode;
  listOrder: OrderMode;
  boolFmt: BoolFmt;
  nullFmt: NullFmt;
}

/** Everything that defines how a table is conditioned into JSON. Saved per profile version. */
export interface ConditionState {
  grid: Grid;
  /** Rules by column index; missing entries get defaults (see `defaultRules`). */
  cond: (ColumnRules | null | undefined)[];
  nameRule: NameRule;
  /** Column indices in rearranged key order; invalid/empty means table order. */
  order: number[];
  opts: ConvertOptions;
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  hdr: true,
  shape: "objects",
  empty: "null",
  keys: "asis",
  infer: true,
  nest: false,
  indent: "2",
  applyCond: true,
  renderOrder: "custom",
  listOrder: "custom",
  boolFmt: "lower",
  nullFmt: "null",
};

export const DEFAULT_NAME_RULE: NameRule = { n: false, q: true };

export type SegKind = "k" | "p" | "s" | "n" | "l" | "u" | "w";
/** A highlighted piece of an output line: key, punctuation, string, number, literal, unquoted text, whitespace. */
export interface Seg {
  t: SegKind;
  v: string;
}
export interface Line {
  text: string;
  segs: Seg[];
  /** Source column index, for column-focused highlighting. */
  col?: number;
}
