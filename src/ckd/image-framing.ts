export interface ImageBox { left: number; top: number; right: number; bottom: number }
export interface ImageSubject { name: string; role: "primary" | "supporting"; box: ImageBox; details: string }
export interface ImageFraming {
  subjects: ImageSubject[];
  layout: "single" | "connected_setup" | "scene" | "screenshot" | "collage";
  prominenceSeverity: number; wastedSpaceSeverity: number;
  tiltDegrees: number | null; tiltRelevant: boolean; perspectiveSeverity: number; backgroundSeverity: number;
  confidence: number; comment: string;
}
const unit={type:"number",minimum:0,maximum:1};
const text={type:"string",minLength:1,maxLength:1500};
const severity={type:"integer",minimum:0,maximum:3};
export const imageBoxSchema={type:"object",additionalProperties:false,required:["left","top","right","bottom"],properties:{left:unit,top:unit,right:unit,bottom:unit}};
export const imageFramingSchema={type:"object",additionalProperties:false,required:["subjects","layout","prominenceSeverity","wastedSpaceSeverity","tiltDegrees","tiltRelevant","perspectiveSeverity","backgroundSeverity","confidence","comment"],properties:{
  subjects:{type:"array",minItems:1,maxItems:8,items:{type:"object",additionalProperties:false,required:["name","role","box","details"],properties:{name:text,role:{enum:["primary","supporting"]},box:imageBoxSchema,details:text}}},
  layout:{enum:["single","connected_setup","scene","screenshot","collage"]},prominenceSeverity:severity,wastedSpaceSeverity:severity,
  tiltDegrees:{anyOf:[{type:"number",minimum:-90,maximum:90},{type:"null"}]},tiltRelevant:{type:"boolean"},perspectiveSeverity:severity,backgroundSeverity:severity,confidence:unit,comment:text
}};
const adequacy=[1,.75,.35,0];
/** A montage/scene is assessed as an instructional layout, not one panel against the whole canvas. */
export function isMultiView(framing: ImageFraming) {
  return framing.layout === 'collage' || framing.layout === 'scene';
}
/** Visual estimates enter here; geometry and the numerical penalty are deterministic. */
export function compositionScore(framing:ImageFraming, enclosing:ImageBox|null, maximum:number, emptyRatio:number){
  const primary=framing.subjects.find(s=>s.role==='primary')!;
  // The primary may be an entire useful assembly. Supporting hands/cables never center it.
  // Necessary gaps inside an assembly are handled by wastedSpaceSeverity, not foreground area.
  const primaries=framing.subjects.filter(s=>s.role==='primary');
  const multiView=isMultiView(framing);
  const box=multiView?{
    left:Math.min(...primaries.map(s=>s.box.left)),top:Math.min(...primaries.map(s=>s.box.top)),
    right:Math.max(...primaries.map(s=>s.box.right)),bottom:Math.max(...primaries.map(s=>s.box.bottom)),
  }:primary.box;
  const margins={left:box.left,top:box.top,right:1-box.right,bottom:1-box.bottom};
  const centerOffset=Math.max(Math.abs((box.left+box.right)/2-.5),Math.abs((box.top+box.bottom)/2-.5));
  const marginImbalance=Math.max(Math.abs(margins.left-margins.right),Math.abs(margins.top-margins.bottom));
  const longAxis=Math.max(primary.box.right-primary.box.left,primary.box.bottom-primary.box.top);
  const prominence=Math.min(adequacy[framing.prominenceSeverity]!,longAxis<.2?.35:longAxis<.35?.75:1);
  // The observation excludes useful internal gaps. Above 70% the worst band
  // still applies here; a separate whole-image cap enforces the stronger rule.
  const space=emptyRatio<=.3?1:emptyRatio<=.5?.75:.5;
  const breakdown=[['space','空间利用',12,space],['background','背景干扰',12,adequacy[framing.backgroundSeverity]!],['prominence','主体突出',6,prominence]] as const;
  const parts=breakdown.map(([key,label,weight,quality])=>({key,label,score:Math.round(weight*quality*maximum/30*100)/100,maximum:weight*maximum/30}));
  const score=Math.round(parts.reduce((sum,p)=>sum+p.score,0)*100)/100;
  return {score,normalized:maximum===0?breakdown.reduce((sum,p)=>sum+p[2]*p[3],0)/30:score/maximum,parts,emptyRatio,primaryBox:primary.box,layoutBox:box,enclosingBox:enclosing,margins,centerOffset,marginImbalance,positionPenaltyApplied:false};
}
