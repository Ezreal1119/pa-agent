import type { AssessmentObservation } from "../../src/ckd/image-assessment.js";
export const assessmentSeen: AssessmentObservation = {
  imageType:"object",subject:"工具",confidence:.95,reason:"主体四周有背景",boundingBox:{left:.25,top:.25,right:.75,bottom:.75},effectiveContentRatio:.25,unrelatedBackgroundRatio:.25,
  framing:{subjects:[{name:"工具",role:"primary",box:{left:.25,top:.25,right:.75,bottom:.75},details:"主体结构"}],layout:"single",prominenceSeverity:0,wastedSpaceSeverity:2,tiltDegrees:0,tiltRelevant:false,perspectiveSeverity:0,backgroundSeverity:0,confidence:.95,comment:"主体居中，周围留白"},
  blurEvidence:{cause:"none",affectsNecessaryDetails:false,comment:"没有明确的必要细节失焦"},
  metrics:{clarity:{level:4,position:"high",confidence:.95,comment:"清晰"},completeness:{level:3,position:"high",confidence:.95,comment:"完整"},exposure:{level:3,position:"high",confidence:.95,comment:"曝光正常"},composition:{position:"mid",confidence:.95,comment:"主体偏小"},obstruction:{level:3,position:"high",confidence:.95,comment:"无遮挡"},color:{level:3,position:"high",confidence:.95,comment:"颜色自然"},artifacts:{level:3,position:"high",confidence:.95,comment:"无压缩问题"}},criticalContentUnreliable:false,detailsClearlyBlurred:false,recommendations:["裁剪周围无关背景"]
};
