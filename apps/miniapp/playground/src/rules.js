export const ORDER = ['info', 'stem', 'response', 'tools'];
export const defaults = () => ({ layoutMode: 'flow', moduleOrder: [...ORDER], practiceStemPercent: 50, analysisDock: 'bottom' });
export function normalize(raw) {
 const d=defaults(); if(!raw || typeof raw!=='object') return d;
 return {layoutMode:raw.layoutMode==='custom'?'custom':'flow',analysisDock:raw.analysisDock==='top'?'top':'bottom',moduleOrder:Array.isArray(raw.moduleOrder)&&raw.moduleOrder.length===4&&ORDER.every(k=>raw.moduleOrder.includes(k))?raw.moduleOrder:d.moduleOrder,practiceStemPercent:Number.isInteger(raw.practiceStemPercent)&&raw.practiceStemPercent>=30&&raw.practiceStemPercent<=70&&raw.practiceStemPercent%5===0?raw.practiceStemPercent:50};
}
export const key=v=>`qanda-layout-playground:${v}`;
export function read(storage,v){try{return normalize(JSON.parse(storage.getItem(key(v))));}catch{return defaults();}}
export function save(storage,v,value){storage.setItem(key(v),JSON.stringify(value));return structuredClone(value);}
export const shouldFloat=(bottom,height)=>bottom>height+1;
export const moved=distance=>Math.abs(distance)>8;
export function analysisHeight(start,delta,dock,max){return Math.max(0,Math.min(max,start+(dock==='top'?delta:-delta)));}
export function settleAnalysis(height,delta,dock){return(dock==='top'?delta<0:delta>0)&&height<=72?0:height;}
export function reorder(order,from,to){const next=order.filter(k=>k!==from);next.splice(order.indexOf(to),0,from);return next;}
export function nearestStop(height,full){return[56,full*.5,full*.9].reduce((a,b)=>Math.abs(b-height)<Math.abs(a-height)?b:a);}

export const canViewAnalysis = (feedback, confirmed) => feedback === 'IMMEDIATE' && confirmed === true;
