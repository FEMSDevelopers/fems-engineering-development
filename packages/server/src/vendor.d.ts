/** Minimal typings for the CAD import libraries (they ship without declarations). */
declare module "dxf" {
  export class Helper {
    constructor(text: string);
    parsed: { header: Record<string, unknown>; entities: unknown[] };
    toSVG(): string;
  }
}
declare module "occt-import-js" {
  interface OcctMesh {
    name?: string;
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index?: { array: number[] };
    color?: number[];
    brep_faces?: { first: number; last: number; color: number[] | null }[];
  }
  interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }
  interface Occt {
    ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  }
  export default function occtimportjs(): Promise<Occt>;
}
