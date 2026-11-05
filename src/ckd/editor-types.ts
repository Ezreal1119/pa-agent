/**
 * 逐工序录入（SOP Editor）的数据类型。
 *
 * 这一层只描述「页面上填了什么」，不描述「文件里长什么样」——
 * 两者的转换全部集中在 editor-library.ts，便于以后单独替换任一端的格式。
 */

export type EditorLanguage = "English" | "中文";
export const EDITOR_LANGUAGES: readonly EditorLanguage[] = ["English", "中文"];

/** 页面提交的一张图（裁剪后的成品），或「沿用 Library 里已有的那张」。 */
export interface EditorPhotoInput {
  /** 新图：data:image/png;base64,... 或 data:image/jpeg;base64,... */
  dataUrl?: string;
  /** 沿用已有图：文件名，如 p1.png；与 dataUrl 二选一。 */
  name?: string;
  /** 仅供错误提示使用，不参与落盘命名。 */
  label?: string;
}

/** 物料行。落盘字段与 Library 既有约定一致：index / partno / spec / qty。 */
export interface EditorBomRowInput {
  partno?: string;
  spec?: string;
  qty?: number | string;
}

/** 工具/治具行。落盘字段：index / name / specs / qty。 */
export interface EditorToolRowInput {
  name?: string;
  specs?: string;
  qty?: number | string;
}

/** 保存一道工序的完整请求。 */
export interface EditorProcessInput {
  /** product_lib 下的项目目录名。 */
  projectId: string;
  language: EditorLanguage;
  /** 页面拖拽顺序，从 1 开始；决定文件夹名 process_NN。 */
  order: number;
  /** Excel 里显示的工序名，落 metadata.txt 第一行。 */
  metadata: string;
  bom?: EditorBomRowInput[];
  tools?: EditorToolRowInput[];
  /** 每张图一段，按顺序一一对应；用空行连接后写入 Operation_Instruction.txt。 */
  paragraphs?: string[];
  photos?: EditorPhotoInput[];
  selfCheck?: string;
  previousStationCheck?: string;
  /** 标准工时（秒），写入 standard_time.txt（本项目扩展字段）。 */
  hours?: number | string;
  /** 标准人力，写入 manpower.txt（本项目扩展字段）。 */
  manpower?: number | string;
}

export interface EditorBomRowRecord {
  index: string;
  partno: string;
  spec: string;
  qty: number;
}

export interface EditorToolRowRecord {
  index: string;
  name: string;
  specs: string;
  qty: number | null;
}

export interface EditorPhotoRecord {
  /** p1.png / p2.png ... */
  name: string;
  dataUrl: string;
}

/** 读回来的一道工序，用于继续编辑。 */
export interface EditorProcessRecord {
  projectId: string;
  language: EditorLanguage;
  order: number;
  /** 文件夹名，如 process_01 */
  folder: string;
  metadata: string;
  bom: EditorBomRowRecord[];
  tools: EditorToolRowRecord[];
  paragraphs: string[];
  photos: EditorPhotoRecord[];
  selfCheck: string;
  previousStationCheck: string;
  hours: number | null;
  manpower: number | null;
}

export interface EditorProjectSummary {
  projectId: string;
  displayName: string;
  /** 当前语言目录下的工序数量；两种语言不同时为默认语言数量。 */
  processCount: number;
}

export interface EditorSaveResult {
  projectId: string;
  language: EditorLanguage;
  order: number;
  folder: string;
  /** 相对 Library 根目录的路径，便于界面显示与排查。 */
  relativePath: string;
  warnings: string[];
}

/** 录入侧的可读取错误，供 HTTP 层映射成 400。 */
export class EditorInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "EditorInputError";
  }
}
