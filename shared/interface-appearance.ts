import type {InterfaceAppearanceGroup,InterfaceSelection} from './contracts/interface';

const interfaceId=/^(?:interface\.default|extension\.[a-z][a-z0-9-]{0,39}\.[a-z][a-z0-9-]{0,39})$/;
const optionId=/^[a-z][a-z0-9-]{0,39}$/;
const validId=(id:string)=>optionId.test(id) && !['constructor','prototype'].includes(id);
export function normalizeInterfaceSelections(value:unknown):Record<string,Record<string,string>>{
  if(!value || typeof value!=='object' || Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([id,values])=>interfaceId.test(id) && values && typeof values==='object' && !Array.isArray(values)).slice(0,32).map(([id,values])=>[id,Object.fromEntries(Object.entries(values as object).filter(([key,value])=>validId(key) && typeof value==='string' && validId(value)).slice(0,8))]));
}
export function validInterfaceSelection(selection:InterfaceSelection){
  return interfaceId.test(selection.interfaceId) && Object.keys(selection.values).length<=8 && Object.entries(selection.values).every(([key,value])=>validId(key) && typeof value==='string' && validId(value));
}
export function resolveInterfaceAppearance(groups:readonly InterfaceAppearanceGroup[]=[],saved:Record<string,string>={}){
  return Object.fromEntries(groups.map(group=>[group.id,group.options.some(option=>option.id===saved[group.id]) ? saved[group.id] : group.defaultOption]));
}
export function interfaceAppearanceKey(groups:readonly InterfaceAppearanceGroup[]=[],saved?:Record<string,string>){
  return groups.length ? JSON.stringify(resolveInterfaceAppearance(groups,saved)) : undefined;
}
