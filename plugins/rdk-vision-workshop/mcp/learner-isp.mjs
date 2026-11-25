import { isDeepStrictEqual } from 'node:util';

const fields=[
  ['exposureUs','曝光时间','曝光','us','exposure','manual_attr.exp_time'],
  ['gain','模拟增益','增益','×','exposure','manual_attr.again'],
  ['contrast','对比度','对比度','','cproc','manual_attr.contrast'],
  ['sharpness','锐度','锐度',''],
  ['whiteBalanceTemperature','白平衡 · 色温','白平衡','K'],
  ['redGain','白平衡 · 红通道增益','白平衡','×','awb','manual_attr.gain.rgain'],
  ['blueGain','白平衡 · 蓝通道增益','白平衡','×','awb','manual_attr.gain.bgain'],
];

const sharpness=[
  ['edgeAutoFirst','锐度 · AUTO（sharp_gain_0_0）','auto_attr.sharp_gain_0_0',0],
  ['edgeUp','锐度 · 上沿增益','manual_attr.enhancement_attr.sharp_gain.up',1],
  ['edgeDown','锐度 · 下沿增益','manual_attr.enhancement_attr.sharp_gain.down',1],
  ['edgeStrength','锐度 · 增强强度','manual_attr.enhancement_attr.strength',1],
];

const rangeIsValid=row=>[row?.value,row?.min,row?.max].every(Number.isFinite)&&
  row.min<row.max&&row.value>=row.min&&row.value<=row.max&&
  (row.step===undefined||Number.isFinite(row.step)&&row.step>0);

export function learnerOptions(config, controls, {nativeSharpness, rules=[]}={}) {
  const native=config.kind==='x5-hbn-isp-v2';
  const options=fields.flatMap(([id,label,group,unit,module,field])=>{
    const row=controls[id];
    if(!rangeIsValid(row)) return [];
    const location=native&&module?['modules',module,field]:['controls',id];
    const sdkValue=readValue(config,location);
    const scale=native&&id==='exposureUs'?1e6:1;
    const disabled=row.active===false?'manual_mode':row.writable!==true?'read_only':
      !Number.isFinite(sdkValue)||sdkValue*scale!==row.value?'snapshot_mismatch':undefined;
    return [{id,label,group,unit:unit||row.unit||'',location,scale,via:'control',
      value:row.value,min:row.min,max:row.max,step:row.step,
      precision:row.nativePrecision??(row.nativeName?.startsWith('hbn_isp_cproc_attr_t.manual_attr.')?'float32':undefined),
      linePeriod:row.nativeLinePeriodUs, ...(disabled?{disabled}:{})}];
  });
  if(native&&!options.some(item=>item.id==='sharpness'&&!item.disabled)) {
    for(const [id,label,field,mode] of sharpness) {
      const location=['modules','edge_enhancement',field];
      const path='/'+location.join('/');
      const rule=rules.find(item=>item.path===path&&!item.transform);
      const row={...rule,value:readValue(config,location)};
      if(!rangeIsValid(row)) continue;
      options.push({id,label,group:'锐度',unit:'SDK',location,scale:1,via:'native',path,
        value:row.value,min:row.min,max:row.max,step:row.step,precision:rule.precision,
        ...(config.modules.edge_enhancement.mode!==mode?{disabled:'manual_mode'}:
          nativeSharpness!==true?{disabled:'native_service_missing'}:{})});
    }
  }
  return options;
}

export function publicLearnerOptions(options) {
  return options.map(({id,label,group,unit,value,min,max,step,linePeriod,disabled})=>
    ({id,label,group,unit,value,min,max,step,linePeriod,disabled}));
}

export function readValue(config,location) {
  return location.reduce((value,key)=>value?.[key],config);
}

export function checkedLearnerValue(option, expected, requested) {
  if(!option||option.disabled) throw new Error('camera_learner_control_unavailable');
  if(expected!==option.value) throw new Error('camera_learner_control_changed');
  const {min,max,step,precision,linePeriod}=option;
  const aligned=value=>!step||Math.abs((value-min)/step-Math.round((value-min)/step))<1e-6;
  if(!Number.isFinite(requested)||requested<min||requested>max||!aligned(requested)) {
    throw new Error('camera_learner_value_out_of_range');
  }
  const normalized=Number.isFinite(linePeriod)&&linePeriod>0
    ? Math.fround(Math.fround(linePeriod/1e6)*Math.round(requested/linePeriod))*1e6
    : precision==='seconds-float32-us'?Math.fround(requested/1e6)*1e6
      :precision==='float32'?Math.fround(requested):requested;
  if(normalized<min||normalized>max||!aligned(normalized)) throw new Error('camera_learner_value_out_of_range');
  if(normalized===option.value) throw new Error('camera_learner_value_unchanged');
  return normalized;
}

export function singleFieldMatches(before, after, option, value) {
  const expected=structuredClone(before);
  const field=option.location.at(-1);
  readValue(expected,option.location.slice(0,-1))[field]=value/option.scale;
  return isDeepStrictEqual(expected,after);
}
